#!/usr/bin/env tsx
/**
 * Builds the melody + structure corpus from several folk-song / hymn sources:
 *   - Essen Folksong Collection (music21's ABC mirror): Chinese (han), German /
 *     Central-European, Irish, and francophone collections.
 *   - thesession.org dump (ODbL): Irish/Scottish dance tunes.
 *   - Open Hymnal Project (public domain): hymns, vendored locally (melody only).
 *
 * Each source is tagged with a region; regions are combined with explicit
 * per-region weights (see DEGREE_WEIGHT / FORM_WEIGHT) so no single source
 * dominates. Outputs src/compose/corpus-data.json with Laplace-smoothed bigram
 * and trigram probability tables over scale degrees 0–6, plus a phrase-form
 * template catalog. The build is deterministic and the output is committed, so
 * there is no network dependency at runtime.
 *
 * Run once: tsx scripts/build-corpus.ts
 */

import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_TEMPLATES, type FormTemplate } from "../src/compose/corpus.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- music theory constants ----------

const MODE_INTERVALS: Record<string, readonly number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

// White-key pitch classes: C=0, D=2, E=4, F=5, G=7, A=9, B=11
const WHITE_KEY_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};
const LETTERS = "CDEFGAB";

// ABC mode name aliases → our internal mode IDs
const MODE_ALIASES: Record<string, string> = {
  "": "ionian",
  maj: "ionian",
  ion: "ionian",
  major: "ionian",
  ionian: "ionian",
  min: "aeolian",
  aeo: "aeolian",
  minor: "aeolian",
  m: "aeolian",
  aeolian: "aeolian",
  dor: "dorian",
  dorian: "dorian",
  mix: "mixolydian",
  mixolydian: "mixolydian",
  phr: "phrygian",
  phrygian: "phrygian",
  lyd: "lydian",
  lydian: "lydian",
};

// ---------- key parsing ----------

interface Key {
  tonic: number; // chromatic PC 0–11
  intervals: readonly number[];
  letterStart: number; // index into CDEFGAB for the tonic letter
}

function parseKey(s: string): Key | null {
  const m = s.trim().match(/^([A-G][#b]?)\s*(.*)/i);
  if (!m) return null;
  const noteStr = m[1]!;
  const modePart = (m[2] ?? "").toLowerCase().trim();

  const letter = noteStr[0]!.toUpperCase();
  const acc = noteStr[1] ?? "";
  const basePc = WHITE_KEY_PC[letter];
  if (basePc === undefined) return null;

  const tonic = (((basePc + (acc === "#" ? 1 : acc === "b" ? -1 : 0)) % 12) + 12) % 12;
  const letterStart = LETTERS.indexOf(letter);

  const modeId = MODE_ALIASES[modePart];
  if (!modeId || !(modeId in MODE_INTERVALS)) return null;

  return { tonic, intervals: MODE_INTERVALS[modeId]!, letterStart };
}

/**
 * Build a lookup table: char-code → default chromatic PC in this key.
 * Applies the key signature (like ABC's K: line) so bare note letters
 * resolve to their diatonic pitch class (e.g. F → F# in G major).
 */
function buildLetterPcMap(key: Key): Uint8Array {
  const map = new Uint8Array(128).fill(255); // 255 = "not a diatonic note letter"
  for (let d = 0; d < 7; d++) {
    const li = (key.letterStart + d) % 7;
    const letter = LETTERS[li]!;
    const pc = (key.tonic + key.intervals[d]!) % 12;
    map[letter.charCodeAt(0)] = pc;
    map[letter.toLowerCase().charCodeAt(0)] = pc;
  }
  return map;
}

// ---------- note-body parsing ----------

/** Extract an ordered sequence of scale degrees (0–6) from an ABC body string. */
function extractDegrees(body: string, key: Key): number[] {
  const letterPcMap = buildLetterPcMap(key);
  const scalePCs = new Set(key.intervals.map((iv) => (key.tonic + iv) % 12));

  // Pre-build degree lookup: PC → degree
  const pcToDegree = new Uint8Array(12).fill(255);
  for (let d = 0; d < 7; d++) {
    pcToDegree[(key.tonic + key.intervals[d]!) % 12] = d;
  }

  const degrees: number[] = [];

  // ABC note token: optional accidental + note letter + octave markers
  // ^^ / __ = double sharp/flat (rare, skip); ^ _ = = single; z/Z = rest (skip)
  const noteRe = /([\\^_=]?)([A-Ga-gz])([',]*)/g;
  let match: RegExpExecArray | null;

  while ((match = noteRe.exec(body)) !== null) {
    const acc = match[1]!;
    const letter = match[2]!;

    // Skip rests
    if (letter === "z" || letter === "Z") continue;

    let pc: number;
    const letterUpper = letter.toUpperCase();
    const basePc = WHITE_KEY_PC[letterUpper];
    if (basePc === undefined) continue;

    if (acc === "^") {
      pc = (basePc + 1) % 12;
    } else if (acc === "_") {
      pc = (((basePc - 1) % 12) + 12) % 12;
    } else if (acc === "=") {
      pc = basePc;
    } else {
      // Apply key signature default
      const defaultPc = letterPcMap[letter.charCodeAt(0)];
      if (defaultPc === undefined || defaultPc === 255) continue;
      pc = defaultPc;
    }

    if (!scalePCs.has(pc)) continue; // chromatic passing tone

    const degree = pcToDegree[pc];
    if (degree === undefined || degree === 255) continue;

    degrees.push(degree);
  }

  return degrees;
}

// ---------- phrase / form extraction ----------

// Barline tokens: end-repeat, start-repeat, thin-thick variants, double bar,
// single bar, and (treated as a boundary) newline.
const BARLINE_RE = /(:\||\|:|::|\|\]|\|\||\||\n)/g;

/** Strip ABC clutter that isn't a note letter or a barline. */
function cleanBody(body: string): string {
  return body
    .replace(/%[^\n]*/g, "\n") // comments
    .replace(/"[^"]*"/g, " ") // chord symbols / annotations
    .replace(/![^!\n]*!/g, " ") // !decorations!
    .replace(/\{[^}]*\}/g, " ") // grace notes
    .replace(/\[[A-Za-z]:[^\]]*\]/g, " "); // inline fields [K:..]
}

/** Split into measures, recording whether each is followed by a strong boundary. */
function splitMeasures(cleaned: string): { text: string; strongAfter: boolean }[] {
  const measures: { text: string; strongAfter: boolean }[] = [];
  let pending = "";
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  BARLINE_RE.lastIndex = 0;
  const flush = (tok: string) => {
    const strong = tok !== "|";
    if (/[A-Ga-g]/.test(pending)) {
      measures.push({ text: pending, strongAfter: strong });
    } else if (strong && measures.length) {
      measures[measures.length - 1]!.strongAfter = true;
    }
    pending = "";
  };
  while ((m = BARLINE_RE.exec(cleaned)) !== null) {
    pending += cleaned.slice(lastIdx, m.index);
    lastIdx = BARLINE_RE.lastIndex;
    flush(m[0]!);
  }
  pending += cleaned.slice(lastIdx);
  flush("||"); // final measure closes a phrase
  return measures;
}

/** Group measures into phrases at strong boundaries; fall back to 4-bar chunks. */
function groupPhrases(
  measures: { text: string; strongAfter: boolean }[],
): { text: string; bars: number }[] {
  const phrases: { text: string; bars: number }[] = [];
  let buf: string[] = [];
  for (let i = 0; i < measures.length; i++) {
    buf.push(measures[i]!.text);
    if (measures[i]!.strongAfter || i === measures.length - 1) {
      if (buf.length) phrases.push({ text: buf.join(" "), bars: buf.length });
      buf = [];
    }
  }
  if (phrases.length < 2 && measures.length >= 4) {
    const chunks: { text: string; bars: number }[] = [];
    for (let i = 0; i < measures.length; i += 4) {
      const chunk = measures.slice(i, i + 4);
      chunks.push({ text: chunk.map((c) => c.text).join(" "), bars: chunk.length });
    }
    return chunks;
  }
  return phrases;
}

/** Resample a degree sequence to a fixed-length vector for similarity comparison. */
function resample(degs: number[], len = 8): number[] {
  if (degs.length === 0) return new Array<number>(len).fill(0);
  const out: number[] = [];
  for (let i = 0; i < len; i++)
    out.push(degs[Math.min(degs.length - 1, Math.floor((i * degs.length) / len))]!);
  return out;
}

/** Two resampled phrases are "the same" if they align within ~1 step after transposition. */
function phraseSimilar(a: number[], b: number[]): boolean {
  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;
  const shift = Math.round(meanB - meanA);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! + shift - b[i]!);
  return diff / a.length <= 1.0;
}

/** Cluster phrase vectors greedily into labels A..D; over-cap or no-repeat => "TC". */
function clusterForm(vecs: number[][]): string {
  const clusters: number[][] = [];
  const labels: string[] = [];
  let overCap = false;
  for (const v of vecs) {
    let assigned = clusters.findIndex((c) => phraseSimilar(c, v));
    if (assigned === -1) {
      if (clusters.length >= 4) {
        overCap = true;
        labels.push("?");
        continue;
      }
      clusters.push(v);
      assigned = clusters.length - 1;
    }
    labels.push(String.fromCharCode(65 + assigned));
  }
  const distinct = new Set(labels);
  if (overCap || distinct.size === labels.length) return "TC";
  return labels.join("");
}

/** Round a bar count to the nearest even value in 2..8. */
function normBars(b: number): number {
  return Math.min(8, Math.max(2, Math.round(b / 2) * 2));
}

// ---------- per-region accumulation ----------
//
// Each source is tagged with a region. Degree counts and form signatures are
// accumulated per region, then combined with equal mass per region (Step:
// combine* below) so no single source — e.g. the very large Chinese (han1/han2)
// or thesession collections — dominates the melodic statistics or the
// form-template catalog.

type Region = "chinese" | "german" | "celtic" | "french" | "session" | "hymn";

const REGION_ORDER: readonly Region[] = [
  "chinese",
  "german",
  "celtic",
  "french",
  "session",
  "hymn",
];

interface FormEntry {
  form: string;
  barsPerPhrase: number[];
  weight: number;
}

interface RegionStats {
  bigrams: number[][]; // 7x7 integer counts
  trigrams: number[][][]; // 7x7x7 integer counts
  formCounts: Map<string, FormEntry>;
  tunes: number;
}

function emptyRegionStats(): RegionStats {
  return {
    bigrams: Array.from({ length: 7 }, () => new Array<number>(7).fill(0)),
    trigrams: Array.from({ length: 7 }, () =>
      Array.from({ length: 7 }, () => new Array<number>(7).fill(0)),
    ),
    formCounts: new Map(),
    tunes: 0,
  };
}

const regionStats = new Map<Region, RegionStats>(REGION_ORDER.map((r) => [r, emptyRegionStats()]));

function accumulateForm(body: string, key: Key, stats: RegionStats): void {
  const phrases = groupPhrases(splitMeasures(cleanBody(body)));
  if (phrases.length < 2 || phrases.length > 8) return;
  const vecs = phrases.map((p) => resample(extractDegrees(p.text, key)));
  if (vecs.some((v) => v.every((d) => d === 0))) return; // a phrase with no notes
  const form = clusterForm(vecs);
  const barsPerPhrase = phrases.map((p) => normBars(p.bars));
  const total = barsPerPhrase.reduce((a, b) => a + b, 0);
  if (total < 12 || total > 32) return;
  const sig = `${form}:${barsPerPhrase.join("-")}`;
  const e = stats.formCounts.get(sig) ?? { form, barsPerPhrase, weight: 0 };
  e.weight++;
  stats.formCounts.set(sig, e);
}

function accumulateTune(tune: string, region: Region): boolean {
  const keyMatch = tune.match(/^K:(.+)$/m);
  if (!keyMatch) return false;
  const key = parseKey(keyMatch[1]!);
  if (!key) return false;

  // Body = everything after the last header line (letter + colon at line start)
  const lines = tune.split("\n");
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^[A-Z]:/.test(lines[i]!)) bodyStart = i + 1;
  }
  const body = lines.slice(bodyStart).join("\n");

  const degrees = extractDegrees(body, key);
  if (degrees.length < 4) return false;

  const stats = regionStats.get(region)!;
  for (let i = 1; i < degrees.length; i++) {
    stats.bigrams[degrees[i - 1]!]![degrees[i]!]!++;
  }
  for (let i = 2; i < degrees.length; i++) {
    stats.trigrams[degrees[i - 2]!]![degrees[i - 1]!]![degrees[i]!]!++;
  }

  accumulateForm(body, key, stats);
  stats.tunes++;
  return true;
}

// ---------- region combination (equal mass per region) ----------

// Base degree-count mass each contributing region is scaled to before summing.
// Large enough to keep combined counts dense, so Laplace smoothing stays a
// gentle nudge and trigram probabilities stay well above the runtime floor.
const REGION_MASS = 100_000;
// Equal form-weight budget per contributing region; comparable to the
// hand-authored FALLBACK_TEMPLATES weights so the catalog stays balanced.
const FORM_MASS = 1000;

// Relative influence per region, kept separate for the two tables because they
// serve different goals and have different sensitivities:
//
// FORM templates — balanced near-equally so the structural variety of every
// idiom surfaces (this is the headline goal: break the through-composed
// dominance and let AABA/ABAC/AABB forms appear). The very large & stylistically
// narrow thesession dance corpus and the tiny celtic sample are capped below
// equal share so they enrich the catalog without swamping it.
const FORM_WEIGHT: Record<Region, number> = {
  chinese: 1,
  german: 1,
  celtic: 0.5,
  french: 1,
  session: 0.35,
  hymn: 1,
};

// DEGREE statistics (bigrams/trigrams) — the original Chinese folk song is kept
// as the melodic backbone (weight 1) with only a light admixture of the other
// idioms. Fully equalizing the degree model flattens it: the diverse mixture
// erases the strong stepwise bias that keeps generated leitmotifs well-formed
// (leap-recovery), so a light admixture is used. It still enriches the
// distribution noticeably (the diatonic tendency tones fa/ti roughly double)
// while preserving melodic quality.
const DEGREE_WEIGHT: Record<Region, number> = {
  chinese: 1,
  german: 0.1,
  celtic: 0.1,
  french: 0.1,
  session: 0.1,
  hymn: 0.1,
};

function combineBigrams(): number[][] {
  const out = Array.from({ length: 7 }, () => new Array<number>(7).fill(0));
  for (const region of REGION_ORDER) {
    const b = regionStats.get(region)!.bigrams;
    let total = 0;
    for (let c = 0; c < 7; c++) for (let n = 0; n < 7; n++) total += b[c]![n]!;
    if (total === 0) continue;
    const factor = (REGION_MASS * DEGREE_WEIGHT[region]) / total;
    for (let c = 0; c < 7; c++) for (let n = 0; n < 7; n++) out[c]![n]! += b[c]![n]! * factor;
  }
  return out;
}

function combineTrigrams(): number[][][] {
  const out = Array.from({ length: 7 }, () =>
    Array.from({ length: 7 }, () => new Array<number>(7).fill(0)),
  );
  for (const region of REGION_ORDER) {
    const tri = regionStats.get(region)!.trigrams;
    // One factor per region (normalize the whole trigram mass) preserves the
    // region's internal contour shape while equalizing across regions.
    let total = 0;
    for (let p = 0; p < 7; p++)
      for (let c = 0; c < 7; c++) for (let n = 0; n < 7; n++) total += tri[p]![c]![n]!;
    if (total === 0) continue;
    const factor = (REGION_MASS * DEGREE_WEIGHT[region]) / total;
    for (let p = 0; p < 7; p++)
      for (let c = 0; c < 7; c++)
        for (let n = 0; n < 7; n++) out[p]![c]![n]! += tri[p]![c]![n]! * factor;
  }
  return out;
}

function combineFormCounts(): Map<string, FormEntry> {
  const out = new Map<string, FormEntry>();
  for (const region of REGION_ORDER) {
    const fc = regionStats.get(region)!.formCounts;
    let total = 0;
    for (const e of fc.values()) total += e.weight;
    if (total === 0) continue;
    const factor = (FORM_MASS * FORM_WEIGHT[region]) / total;
    for (const sig of [...fc.keys()].sort()) {
      // sorted -> deterministic float adds
      const e = fc.get(sig)!;
      const cur = out.get(sig) ?? { form: e.form, barsPerPhrase: e.barsPerPhrase, weight: 0 };
      cur.weight += e.weight * factor;
      out.set(sig, cur);
    }
  }
  return out;
}

/** Top-N aggregated form templates, deterministically sorted. */
function buildFormTemplates(combined: Map<string, FormEntry>, limit = 40): FormTemplate[] {
  const templates = [...combined.values()]
    .map((e) => ({
      form: e.form,
      barsPerPhrase: e.barsPerPhrase,
      weight: Math.max(1, Math.round(e.weight)),
      totalBars: e.barsPerPhrase.reduce((a, b) => a + b, 0),
    }))
    .sort(
      (a, b) => b.weight - a.weight || a.form.localeCompare(b.form) || a.totalBars - b.totalBars,
    )
    .slice(0, limit);
  return templates.length > 0 ? templates : FALLBACK_TEMPLATES;
}

// ---------- sources ----------

const ESSEN =
  "https://raw.githubusercontent.com/cuthbertLab/music21/master/music21/corpus/essenFolksong";

type SourceKind = "abc-url" | "session-csv" | "abc-local";
interface Source {
  kind: SourceKind;
  ref: string;
  region: Region;
  label: string;
}

function essen(file: string, region: Region): Source {
  return { kind: "abc-url", ref: `${ESSEN}/${file}.abc`, region, label: `${file}.abc` };
}

// Ordered & explicit for determinism. Essen files live on the same already-allowed
// host as the original three; thesession is on the same host (raw.githubusercontent);
// the hymn corpus is vendored locally (scripts/data/openhymnal.abc), so it needs no
// network at build time.
const SOURCES: Source[] = [
  // Chinese (Han) folk song — the original corpus.
  essen("han1", "chinese"),
  essen("han2", "chinese"),
  // German / Central-European Essen collections.
  essen("altdeu10", "german"),
  essen("altdeu20", "german"),
  essen("ballad10", "german"),
  essen("ballad20", "german"),
  essen("ballad30", "german"),
  essen("ballad40", "german"),
  essen("ballad50", "german"),
  essen("ballad60", "german"),
  essen("ballad70", "german"),
  essen("ballad80", "german"),
  essen("boehme10", "german"),
  essen("boehme20", "german"),
  essen("dva0", "german"),
  essen("erk5", "german"),
  essen("erk10", "german"),
  essen("erk20", "german"),
  essen("erk30", "german"),
  essen("fink0", "german"),
  essen("folkHaydn", "german"),
  essen("kinder0", "german"),
  essen("variant0", "german"),
  essen("zuccal0", "german"),
  // Irish (Essen).
  essen("irl", "celtic"),
  // Francophone (Lorraine, Luxembourg).
  essen("lot", "french"),
  essen("lux", "french"),
  // thesession.org dump (ODbL) — Irish/Scottish dance tunes, strong AABB structure.
  {
    kind: "session-csv",
    ref: "https://raw.githubusercontent.com/adactio/TheSession-data/main/csv/tunes.csv",
    region: "session",
    label: "thesession/tunes.csv",
  },
  // Open Hymnal Project (public domain), vendored & melody-only — strong AABA / verse-refrain forms.
  {
    kind: "abc-local",
    ref: join(__dirname, "data", "openhymnal.abc"),
    region: "hymn",
    label: "openhymnal.abc",
  },
];

// ---------- source parsing ----------

/** Split a concatenated ABC document into individual tune records. */
function splitAbcTunes(text: string): string[] {
  return text.split(/(?=^X:\d)/m).filter((t) => t.trim().startsWith("X:"));
}

/** Minimal RFC-4180 CSV reader (handles quoted fields with embedded commas/newlines). */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Turn thesession `tunes.csv` rows into ABC tune records. Columns:
 * tune_id, setting_id, name, type, meter, mode, abc, date, username, composer.
 * The `mode` column ("Gmajor"/"Edorian"/...) is split into tonic + mode word
 * to synthesize the K: header the parser expects.
 */
function sessionTunes(csv: string): string[] {
  const rows = parseCsvRows(csv);
  const tunes: string[] = [];
  for (let r = 1; r < rows.length; r++) {
    // skip header
    const cols = rows[r]!;
    if (cols.length < 7) continue;
    const meter = cols[4]!.trim();
    const mode = cols[5]!.trim();
    const abc = cols[6]!;
    if (!abc) continue;
    const km = mode.match(/^([A-Ga-g][#b]?)(.*)$/);
    if (!km) continue;
    const key = `${km[1]!.toUpperCase()} ${km[2]!.toLowerCase()}`.trim();
    tunes.push(`X:1\nM:${meter || "4/4"}\nL:1/8\nK:${key}\n${abc}`);
  }
  return tunes;
}

/** Fetch/read a source and return its individual ABC tune records (or null on network failure). */
async function loadSource(src: Source): Promise<string[] | null> {
  if (src.kind === "abc-local") {
    return splitAbcTunes(readFileSync(src.ref, "utf8"));
  }
  const res = await fetch(src.ref);
  if (!res.ok) {
    console.log(`HTTP ${res.status} — skipping`);
    return null;
  }
  const text = await res.text();
  return src.kind === "session-csv" ? sessionTunes(text) : splitAbcTunes(text);
}

// ---------- download + process ----------

async function main(): Promise<void> {
  let totalTunes = 0;
  let networkTunes = 0; // tunes from networked sources only — drives the no-network fallback

  for (const src of SOURCES) {
    process.stdout.write(`[${src.region}] ${src.label} ... `);
    const tunes = await loadSource(src);
    if (tunes === null) continue;
    let count = 0;
    for (const tune of tunes) {
      if (accumulateTune(tune, src.region)) count++;
    }
    console.log(`${count} tunes`);
    totalTunes += count;
    if (src.kind !== "abc-local") networkTunes += count;
  }

  const outPath = join(__dirname, "..", "src", "compose", "corpus-data.json");

  if (networkTunes === 0) {
    // No network: preserve the committed melodic tables, only ensure the
    // form-template catalog exists (hand-authored fallback). The vendored local
    // source alone is not enough to rebuild a balanced corpus.
    console.error(
      "No networked tunes processed (no network?). Preserving existing tables, adding fallback form templates.",
    );
    const existing = JSON.parse(readFileSync(outPath, "utf8")) as {
      bigrams: number[][];
      trigrams: number[][][];
      formTemplates?: FormTemplate[];
    };
    existing.formTemplates = existing.formTemplates?.length
      ? existing.formTemplates
      : FALLBACK_TEMPLATES;
    writeFileSync(outPath, JSON.stringify(existing));
    console.log(`Wrote ${outPath} (fallback form templates: ${existing.formTemplates.length})`);
    return;
  }

  // Per-region summary (diagnostic only; not written to the JSON).
  console.log("\nPer-region tunes:");
  for (const region of REGION_ORDER) {
    const s = regionStats.get(region)!;
    if (s.tunes > 0)
      console.log(`  ${region.padEnd(8)} ${s.tunes} tunes, ${s.formCounts.size} form signatures`);
  }
  console.log(`Processed ${totalTunes} tunes total`);

  // Combine regions with equal mass, then Laplace-smooth (+1) and normalize each
  // context row to a probability distribution.
  const bigrams = combineBigrams();
  const trigrams = combineTrigrams();

  const bigramProb = bigrams.map((row) => {
    const smoothed = row.map((c) => c + 1);
    const total = smoothed.reduce((a, b) => a + b, 0);
    return smoothed.map((c) => c / total);
  });

  const trigramProb = trigrams.map((prev) =>
    prev.map((curr) => {
      const smoothed = curr.map((c) => c + 1);
      const total = smoothed.reduce((a, b) => a + b, 0);
      return smoothed.map((c) => c / total);
    }),
  );

  const formTemplates = buildFormTemplates(combineFormCounts());
  const tcWeight = formTemplates.filter((t) => t.form === "TC").reduce((a, t) => a + t.weight, 0);
  const allWeight = formTemplates.reduce((a, t) => a + t.weight, 0);

  const out = { bigrams: bigramProb, trigrams: trigramProb, formTemplates };
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`Wrote ${outPath}`);
  console.log(`Table size: bigrams 7×7, trigrams 7×7×7, form templates: ${formTemplates.length}`);
  console.log(
    `Through-composed (TC) share of form weight: ${((100 * tcWeight) / allWeight).toFixed(1)}%`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
