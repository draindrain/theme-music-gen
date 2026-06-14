#!/usr/bin/env tsx
/**
 * Builds the melody transition corpus from the Essen Folksong Collection
 * (via music21's GitHub mirror of the ABC files).
 *
 * Outputs src/compose/corpus-data.json with Laplace-smoothed bigram and
 * trigram probability tables over scale degrees 0–6.
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
  ionian:         [0, 2, 4, 5, 7, 9, 11],
  lydian:         [0, 2, 4, 6, 7, 9, 11],
  mixolydian:     [0, 2, 4, 5, 7, 9, 10],
  dorian:         [0, 2, 3, 5, 7, 9, 10],
  aeolian:        [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  phrygian:       [0, 1, 3, 5, 7, 8, 10],
};

// White-key pitch classes: C=0, D=2, E=4, F=5, G=7, A=9, B=11
const WHITE_KEY_PC: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};
const LETTERS = "CDEFGAB";

// ABC mode name aliases → our internal mode IDs
const MODE_ALIASES: Record<string, string> = {
  "": "ionian", "maj": "ionian", "ion": "ionian", "major": "ionian",
  "min": "aeolian", "aeo": "aeolian", "minor": "aeolian", "m": "aeolian",
  "dor": "dorian", "mix": "mixolydian", "phr": "phrygian",
  "lyd": "lydian",
};

// ---------- key parsing ----------

interface Key {
  tonic: number;              // chromatic PC 0–11
  intervals: readonly number[];
  letterStart: number;        // index into CDEFGAB for the tonic letter
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

  const tonic = ((basePc + (acc === "#" ? 1 : acc === "b" ? -1 : 0)) % 12 + 12) % 12;
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
      pc = ((basePc - 1) % 12 + 12) % 12;
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
function groupPhrases(measures: { text: string; strongAfter: boolean }[]): { text: string; bars: number }[] {
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
  for (let i = 0; i < len; i++) out.push(degs[Math.min(degs.length - 1, Math.floor((i * degs.length) / len))]!);
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
      if (clusters.length >= 4) { overCap = true; labels.push("?"); continue; }
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

// form signature -> aggregated template
const formCounts = new Map<string, { form: string; barsPerPhrase: number[]; weight: number }>();

function accumulateForm(body: string, key: Key): void {
  const phrases = groupPhrases(splitMeasures(cleanBody(body)));
  if (phrases.length < 2 || phrases.length > 8) return;
  const vecs = phrases.map((p) => resample(extractDegrees(p.text, key)));
  if (vecs.some((v) => v.every((d) => d === 0))) return; // a phrase with no notes
  const form = clusterForm(vecs);
  const barsPerPhrase = phrases.map((p) => normBars(p.bars));
  const total = barsPerPhrase.reduce((a, b) => a + b, 0);
  if (total < 12 || total > 32) return;
  const sig = `${form}:${barsPerPhrase.join("-")}`;
  const e = formCounts.get(sig) ?? { form, barsPerPhrase, weight: 0 };
  e.weight++;
  formCounts.set(sig, e);
}

// ---------- corpus accumulation ----------

// Raw count tables (7 scale degrees)
const bigrams: number[][] = Array.from({ length: 7 }, () => new Array<number>(7).fill(0));
const trigrams: number[][][] = Array.from({ length: 7 }, () =>
  Array.from({ length: 7 }, () => new Array<number>(7).fill(0))
);

function accumulateTune(tune: string): boolean {
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

  for (let i = 1; i < degrees.length; i++) {
    bigrams[degrees[i - 1]!]![degrees[i]!]!++;
  }
  for (let i = 2; i < degrees.length; i++) {
    trigrams[degrees[i - 2]!]![degrees[i - 1]!]![degrees[i]!]!++;
  }

  accumulateForm(body, key);

  return true;
}

/** Top-N aggregated form templates, deterministically sorted. */
function buildFormTemplates(limit = 40): FormTemplate[] {
  const templates = [...formCounts.values()]
    .map((e) => ({ ...e, totalBars: e.barsPerPhrase.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.weight - a.weight || a.form.localeCompare(b.form) || a.totalBars - b.totalBars)
    .slice(0, limit);
  return templates.length > 0 ? templates : FALLBACK_TEMPLATES;
}

// ---------- download + process ----------

const SOURCES = [
  "https://raw.githubusercontent.com/cuthbertLab/music21/master/music21/corpus/essenFolksong/han1.abc",
  "https://raw.githubusercontent.com/cuthbertLab/music21/master/music21/corpus/essenFolksong/han2.abc",
  "https://raw.githubusercontent.com/cuthbertLab/music21/master/music21/corpus/essenFolksong/erk5.abc",
];

async function main(): Promise<void> {
  let totalTunes = 0;
  let totalDegrees = 0;

  for (const url of SOURCES) {
    process.stdout.write(`Fetching ${url.split("/").pop()} ... `);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`HTTP ${res.status} — skipping`);
      continue;
    }
    const text = await res.text();

    // Split on X: record markers
    const tunes = text.split(/(?=^X:\d)/m).filter((t) => t.trim().startsWith("X:"));
    let count = 0;
    for (const tune of tunes) {
      if (accumulateTune(tune)) count++;
    }
    console.log(`${count} tunes`);
    totalTunes += count;
  }

  const outPath = join(__dirname, "..", "src", "compose", "corpus-data.json");

  if (totalTunes === 0) {
    // No network: preserve the committed melodic tables, only ensure the
    // form-template catalog exists (hand-authored fallback).
    console.error("No tunes processed (no network?). Preserving existing tables, adding fallback form templates.");
    const existing = JSON.parse(readFileSync(outPath, "utf8")) as {
      bigrams: number[][]; trigrams: number[][][]; formTemplates?: FormTemplate[];
    };
    existing.formTemplates = existing.formTemplates?.length ? existing.formTemplates : FALLBACK_TEMPLATES;
    writeFileSync(outPath, JSON.stringify(existing));
    console.log(`Wrote ${outPath} (fallback form templates: ${existing.formTemplates.length})`);
    return;
  }

  // Count total degree observations from bigrams
  for (let c = 0; c < 7; c++) {
    for (let n = 0; n < 7; n++) totalDegrees += bigrams[c]![n]!;
  }
  console.log(`\nProcessed ${totalTunes} tunes, ${totalDegrees} diatonic transitions`);

  // Laplace smoothing (+1 to every cell) then normalize each context row to probabilities
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
    })
  );

  const formTemplates = buildFormTemplates();
  const out = { bigrams: bigramProb, trigrams: trigramProb, formTemplates };
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`Wrote ${outPath}`);
  console.log(`Table size: bigrams 7×7, trigrams 7×7×7, form templates: ${formTemplates.length}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
