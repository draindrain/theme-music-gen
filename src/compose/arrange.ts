/**
 * Mood arrangement: turn a subject's fixed leitmotif into a full Score for
 * a given mood. The mood changes mode color, tempo, articulation, harmony and
 * which layers play — never the theme's degree/rhythm sequence.
 */
import type { CharacterParams, Mode, Mood } from "../schema/params.ts";
import {
  MODE_BRIGHTNESS_ORDER,
  voiceLeadTriads,
  degreeToMidi,
  type Key,
} from "../theory/theory.ts";
import type { Note, Score, Track } from "../score/types.ts";
import { Rng } from "../util/prng.ts";
import { generateTheme, generateEpisode, THEME_LENGTH_BEATS, type Theme } from "./theme.ts";
import { formTemplates, type FormTemplate } from "./corpus.ts";

type HarmonyStyle = "sustained" | "offbeat" | "pulse" | "sparse";
type BassStyle = "whole" | "halves" | "pulse" | "arpeggiated";
/** Shape of the dynamic (velocity) arc over the whole song. */
type DynamicArc = "arch" | "build" | "decay" | "bookend";

interface MoodProfile {
  /** steps along the mode-brightness ordering; negative = brighter */
  modeShift: number;
  tempoFactor: number;
  /** chord root degrees on home (theme-label) sections, 4 bars repeated */
  progressionA: number[];
  /** chord root degrees on contrasting (non-home) sections */
  progressionB: number[];
  /** note-length multiplier: <1 staccato, ~1 legato */
  articulation: number;
  velocity: number;
  /** lead register shift in scale degrees (7 = octave) */
  registerShift: number;
  layers: { pad: boolean; arp: boolean; counter: boolean; percussion: boolean };
  /** delay applied to off-beat eighths, in beats */
  swing: number;
  /** additive bias to per-section density (texture activity), -0.3..0.3 */
  densityBias: number;
  /** velocity arc shape across the song */
  dynamicArc: DynamicArc;
  /** chance a repeated section drops the lead (call-and-response via handoff) */
  restProbability: number;
  /** chance a repeated section is lightly varied rather than literal */
  varyProbability: number;
  /** harmony / bass styles on home vs. contrasting sections */
  preferredHarmony: HarmonyStyle;
  contrastHarmony: HarmonyStyle;
  preferredBass: BassStyle;
  contrastBass: BassStyle;
}

export const MOOD_PROFILES: Record<Mood, MoodProfile> = {
  happy: {
    modeShift: -2,
    tempoFactor: 1.1,
    progressionA: [0, 4, 5, 3],
    progressionB: [3, 4, 0, 4],
    articulation: 0.85,
    velocity: 0.78,
    registerShift: 0,
    layers: { pad: false, arp: true, counter: false, percussion: true },
    swing: 0.08,
    densityBias: 0.1,
    dynamicArc: "build",
    restProbability: 0.15,
    varyProbability: 0.5,
    preferredHarmony: "offbeat",
    contrastHarmony: "offbeat",
    preferredBass: "halves",
    contrastBass: "arpeggiated",
  },
  sad: {
    modeShift: 2,
    tempoFactor: 0.78,
    progressionA: [0, 5, 3, 4],
    progressionB: [5, 3, 0, 4],
    articulation: 1.02,
    velocity: 0.52,
    registerShift: -7,
    layers: { pad: true, arp: false, counter: false, percussion: false },
    swing: 0,
    densityBias: -0.2,
    dynamicArc: "arch",
    restProbability: 0.35,
    varyProbability: 0.3,
    preferredHarmony: "sustained",
    contrastHarmony: "sparse",
    preferredBass: "whole",
    contrastBass: "whole",
  },
  tense: {
    modeShift: 3,
    tempoFactor: 1.04,
    progressionA: [0, 1, 0, 4],
    progressionB: [3, 1, 4, 0],
    articulation: 0.65,
    velocity: 0.7,
    registerShift: -7,
    layers: { pad: true, arp: true, counter: false, percussion: true },
    swing: 0,
    densityBias: 0.15,
    dynamicArc: "build",
    restProbability: 0.2,
    varyProbability: 0.45,
    preferredHarmony: "pulse",
    contrastHarmony: "pulse",
    preferredBass: "pulse",
    contrastBass: "pulse",
  },
  tender: {
    modeShift: 0,
    tempoFactor: 0.88,
    progressionA: [0, 2, 3, 0],
    progressionB: [5, 3, 0, 4],
    articulation: 1.0,
    velocity: 0.5,
    registerShift: 0,
    layers: { pad: true, arp: false, counter: true, percussion: false },
    swing: 0,
    densityBias: -0.1,
    dynamicArc: "bookend",
    restProbability: 0.3,
    varyProbability: 0.4,
    preferredHarmony: "sustained",
    contrastHarmony: "offbeat",
    preferredBass: "whole",
    contrastBass: "halves",
  },
  playful: {
    modeShift: -1,
    tempoFactor: 1.18,
    progressionA: [0, 3, 0, 4],
    progressionB: [5, 3, 4, 0],
    articulation: 0.55,
    velocity: 0.74,
    registerShift: 0,
    layers: { pad: false, arp: true, counter: false, percussion: true },
    swing: 0.12,
    densityBias: 0.05,
    dynamicArc: "arch",
    restProbability: 0.25,
    varyProbability: 0.6,
    preferredHarmony: "offbeat",
    contrastHarmony: "sparse",
    preferredBass: "arpeggiated",
    contrastBass: "halves",
  },
  melancholy: {
    modeShift: 1,
    tempoFactor: 0.82,
    progressionA: [0, 5, 2, 4],
    progressionB: [3, 5, 0, 4],
    articulation: 0.95,
    velocity: 0.58,
    registerShift: 0,
    layers: { pad: true, arp: false, counter: true, percussion: false },
    swing: 0,
    densityBias: -0.15,
    dynamicArc: "decay",
    restProbability: 0.3,
    varyProbability: 0.35,
    preferredHarmony: "sustained",
    contrastHarmony: "sustained",
    preferredBass: "halves",
    contrastBass: "whole",
  },
};

const TEMPO_BPM: Record<CharacterParams["baseTempo"], number> = {
  very_slow: 63,
  slow: 78,
  medium: 96,
  fast: 116,
  very_fast: 138,
};

export function effectiveMode(base: Mode, shift: number): Mode {
  const i = MODE_BRIGHTNESS_ORDER.indexOf(base);
  const j = Math.min(MODE_BRIGHTNESS_ORDER.length - 1, Math.max(0, i + shift));
  return MODE_BRIGHTNESS_ORDER[j]!;
}

const BEATS_PER_BAR = 4;
const THEME_BARS = THEME_LENGTH_BEATS / BEATS_PER_BAR; // 2-bar leitmotif phrase

// ---------------------------------------------------------------------------
// Section model — the song's macro-structure, driven by a corpus form template
// ---------------------------------------------------------------------------
type ThemePresence = "theme" | "theme_var" | "episode" | "episode_var" | "frag" | "rest";

interface Section {
  /** phrase label from the form template ('A','B',...) */
  label: string;
  startBar: number;
  bars: number;
  /** first time this label appears in the song */
  isFirstOccurrence: boolean;
  /** what the lead plays in this section */
  content: ThemePresence;
  /** texture activity 0..1 */
  density: number;
  /** velocity multiplier from the song's dynamic arc */
  dynamic: number;
  harmony: HarmonyStyle;
  bass: BassStyle;
  /** per-section layer gating (arp / percussion); pad & counter are song-wide */
  arp: boolean;
  percussion: boolean;
}

/** Sample the velocity arc at normalized song position t in [0,1]. */
function dynamicAt(arc: DynamicArc, t: number): number {
  switch (arc) {
    case "arch":
      return 0.8 + 0.2 * Math.sin(Math.PI * t);
    case "build":
      return 0.78 + 0.22 * t;
    case "decay":
      return 1.0 - 0.22 * t;
    case "bookend":
      return 0.85 + 0.15 * Math.abs(2 * t - 1);
  }
}

/** Per-phrase labels for a template; through-composed cycles A/B/C. */
function templateLabels(template: FormTemplate): string[] {
  const n = template.barsPerPhrase.length;
  if (template.form !== "TC" && template.form.length === n) return template.form.split("");
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + (i % 3)));
}

/**
 * Expand a form template into a sequence of sections with per-section
 * presentation, dynamics and texture. The first occurrence of the home label
 * is ALWAYS a literal "theme" statement so the leitmotif is always present.
 */
function buildSections(template: FormTemplate, profile: MoodProfile, rng: Rng): Section[] {
  const labels = templateLabels(template);
  const homeLabel = labels[0]!;
  const totalBars = template.totalBars;
  const seen = new Set<string>();
  const sections: Section[] = [];
  let startBar = 0;

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const bars = template.barsPerPhrase[i]!;
    const isFirst = !seen.has(label);
    seen.add(label);
    const isHome = label === homeLabel;

    let content: ThemePresence;
    if (isHome) {
      content = isFirst ? "theme" : rng.chance(profile.varyProbability) ? "theme_var" : "theme";
    } else {
      content = isFirst
        ? "episode"
        : rng.chance(profile.varyProbability)
          ? "episode_var"
          : "episode";
    }
    // A repeated (non-first) section may drop the lead for call-and-response.
    if (!isFirst && rng.chance(profile.restProbability)) content = "rest";

    const t = totalBars > bars ? startBar / (totalBars - bars) : 0;
    const baseDensity = content === "rest" ? 0.3 : isHome ? 0.8 : 0.6;
    const density = Math.min(1, Math.max(0, baseDensity + profile.densityBias));
    const isIntro = i === 0;

    sections.push({
      label,
      startBar,
      bars,
      isFirstOccurrence: isFirst,
      content,
      density,
      dynamic: dynamicAt(profile.dynamicArc, t),
      harmony: isHome ? profile.preferredHarmony : profile.contrastHarmony,
      bass: isHome ? profile.preferredBass : profile.contrastBass,
      // intro starts sparse; low-density sections drop percussion (breakdown)
      arp: profile.layers.arp && !isIntro,
      percussion: profile.layers.percussion && density >= 0.45,
    });
    startBar += bars;
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Note helpers
// ---------------------------------------------------------------------------

/** Place the theme's notes starting at a bar, with optional degree offset. */
function themeNotes(
  theme: Theme,
  key: Key,
  octave: number,
  startBar: number,
  opts: { degreeOffset?: number; articulation: number; velocity: number; rng: Rng; swing: number },
): Note[] {
  const out: Note[] = [];
  const base = startBar * BEATS_PER_BAR;
  for (let i = 0; i < theme.degrees.length; i++) {
    let onset = theme.onsets[i]!;
    if (opts.swing > 0 && Math.abs((onset % 1) - 0.5) < 1e-6) onset += opts.swing;
    out.push({
      startBeat: base + onset,
      durBeats: Math.max(0.15, theme.durations[i]! * opts.articulation),
      midi: degreeToMidi(key, theme.degrees[i]! + (opts.degreeOffset ?? 0), octave),
      velocity: clamp01(opts.velocity + opts.rng.range(-0.05, 0.05)),
    });
  }
  return out;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** First half of the theme transposed by `degreeOffset` — B-section development. */
function fragmentNotes(
  theme: Theme,
  key: Key,
  octave: number,
  startBar: number,
  degreeOffset: number,
  profile: MoodProfile,
  rng: Rng,
): Note[] {
  const half = Math.ceil(theme.degrees.length / 2);
  const frag: Theme = {
    degrees: theme.degrees.slice(0, half),
    onsets: theme.onsets.slice(0, half),
    durations: theme.durations.slice(0, half),
  };
  return themeNotes(frag, key, octave, startBar, {
    degreeOffset,
    articulation: profile.articulation,
    velocity: profile.velocity - 0.06,
    rng,
    swing: profile.swing,
  });
}

// ---------------------------------------------------------------------------
// Harmony helpers
// ---------------------------------------------------------------------------

function harmonyBar(
  bar: number,
  voicing: number[],
  style: HarmonyStyle,
  vel: number,
  rng: Rng,
  swing: number,
): Note[] {
  const out: Note[] = [];
  const b = bar * BEATS_PER_BAR;
  if (style === "sustained") {
    for (const m of voicing)
      out.push({
        startBeat: b,
        durBeats: 4.0,
        midi: m,
        velocity: clamp01(vel + rng.range(-0.04, 0.04)),
      });
  } else if (style === "offbeat") {
    for (const beat of [1, 3])
      for (const m of voicing)
        out.push({
          startBeat: b + beat,
          durBeats: 0.6,
          midi: m,
          velocity: clamp01(vel + rng.range(-0.04, 0.04)),
        });
  } else if (style === "pulse") {
    for (let e = 0; e < 8; e += 2)
      for (const m of voicing)
        out.push({
          startBeat: b + e / 2,
          durBeats: 0.3,
          midi: m,
          velocity: clamp01(vel * (e % 4 === 0 ? 1 : 0.8)),
        });
  } else {
    // sparse: beat 1 of every other bar only
    if (bar % 2 === 0)
      for (const m of voicing)
        out.push({
          startBeat: b,
          durBeats: 3.8,
          midi: m,
          velocity: clamp01(vel * 0.85 + rng.range(-0.04, 0.04)),
        });
  }
  void swing;
  return out;
}

function bassBar(bar: number, chordRoot: number, key: Key, style: BassStyle, vel: number): Note[] {
  const out: Note[] = [];
  const b = bar * BEATS_PER_BAR;
  const rootMidi = degreeToMidi(key, chordRoot, 2);
  const fifthMidi = degreeToMidi(key, chordRoot + 4, 2);
  switch (style) {
    case "whole":
      out.push({ startBeat: b, durBeats: 4, midi: rootMidi, velocity: vel });
      break;
    case "halves":
      out.push({ startBeat: b, durBeats: 1.8, midi: rootMidi, velocity: vel });
      out.push({
        startBeat: b + 2,
        durBeats: 1.8,
        midi: bar % 2 ? fifthMidi : rootMidi,
        velocity: vel * 0.9,
      });
      break;
    case "pulse":
      for (let e = 0; e < 8; e++)
        out.push({
          startBeat: b + e / 2,
          durBeats: 0.4,
          midi: rootMidi,
          velocity: vel * (e % 2 ? 0.75 : 1),
        });
      break;
    case "arpeggiated": {
      const tones = [rootMidi, fifthMidi, rootMidi + 12, fifthMidi];
      for (let q = 0; q < 4; q++)
        out.push({
          startBeat: b + q,
          durBeats: 0.7,
          midi: tones[q]!,
          velocity: vel * (q === 0 ? 1 : 0.85),
        });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main composition entry point
// ---------------------------------------------------------------------------

export function composeScore(params: CharacterParams, mood: Mood): Score {
  const profile = MOOD_PROFILES[mood];
  const theme = generateTheme(params);
  // Structure RNG is keyed by subject + mood, so two characters in the same
  // mood get DIFFERENT macro-structure. The theme itself stays mood-independent.
  const rng = new Rng(params.seed).fork(`arr:${params.id}:${mood}`);
  const key: Key = {
    tonic: params.key.tonic,
    mode: effectiveMode(params.key.mode, profile.modeShift),
  };
  const tempoBpm = Math.round(TEMPO_BPM[params.baseTempo] * profile.tempoFactor);

  const leadOctave =
    5 +
    (params.brightness === "bright" ? 0 : params.brightness === "dark" ? -1 : 0) +
    Math.round(profile.registerShift / 7);

  // --- form: sample a corpus-derived phrase-form template, expand to sections ---
  const template = rng
    .fork("form")
    .pickWeighted(formTemplates().map((t) => [t, t.weight] as const));
  const sections = buildSections(template, profile, rng.fork("sections"));
  const totalBars = template.totalBars;
  const loopBeatsTotal = totalBars * BEATS_PER_BAR;
  const homeLabel = sections[0]!.label;

  // bar -> section lookup
  const barToSection: Section[] = new Array<Section>(totalBars);
  for (const sec of sections)
    for (let b = 0; b < sec.bars; b++) barToSection[sec.startBar + b] = sec;

  // --- chord plan: progression tiled per section (home=A, contrasting=B) ---
  const chordRoots: number[] = [];
  for (let bar = 0; bar < totalBars; bar++) {
    const sec = barToSection[bar]!;
    const prog = sec.label === homeLabel ? profile.progressionA : profile.progressionB;
    chordRoots.push(prog[(bar - sec.startBar) % prog.length]!);
  }
  const voicings = voiceLeadTriads(key, chordRoots, 4);

  // --- material per phrase label: home label = theme, others = episodes ---
  const episodeRng = rng.fork("episode");
  const materialByLabel = new Map<string, Theme>([[homeLabel, theme]]);
  for (const sec of sections)
    if (!materialByLabel.has(sec.label))
      materialByLabel.set(sec.label, generateEpisode(theme, episodeRng));

  // --- lead: walk sections, filling each with repeats of its 2-bar material ---
  const leadRng = rng.fork("lead");
  const lead: Note[] = [];
  const handoffBars: number[] = []; // section-start bars where the lead rests

  for (const sec of sections) {
    if (sec.content === "rest") {
      for (let r = 0; r * THEME_BARS < sec.bars; r++)
        handoffBars.push(sec.startBar + r * THEME_BARS);
      continue;
    }
    const material = materialByLabel.get(sec.label)!;
    const varOffset = leadRng.pick([2, -2] as const);
    const reps = Math.max(1, Math.floor(sec.bars / THEME_BARS));
    for (let r = 0; r < reps; r++) {
      const bar = sec.startBar + r * THEME_BARS;
      const vel = profile.velocity * sec.dynamic * (r === 0 ? 1 : 0.9);
      switch (sec.content) {
        case "theme":
          lead.push(
            ...themeNotes(theme, key, leadOctave, bar, {
              articulation: profile.articulation,
              velocity: vel,
              rng: leadRng,
              swing: profile.swing,
            }),
          );
          break;
        case "theme_var":
          lead.push(
            ...themeNotes(theme, key, leadOctave, bar, {
              degreeOffset: varOffset,
              articulation: profile.articulation,
              velocity: vel * 0.95,
              rng: leadRng,
              swing: profile.swing,
            }),
          );
          break;
        case "episode":
          lead.push(
            ...themeNotes(material, key, leadOctave, bar, {
              articulation: profile.articulation,
              velocity: vel * 0.95,
              rng: leadRng,
              swing: profile.swing,
            }),
          );
          break;
        case "episode_var":
          lead.push(
            ...themeNotes(material, key, leadOctave, bar, {
              degreeOffset: varOffset,
              articulation: profile.articulation,
              velocity: vel * 0.95,
              rng: leadRng,
              swing: profile.swing,
            }),
          );
          break;
        case "frag":
          lead.push(...fragmentNotes(theme, key, leadOctave, bar, 0, profile, leadRng));
          break;
      }
    }
  }

  // --- harmony: voice-led triads, style + dynamics + density per section ---
  const harmony: Note[] = [];
  const harmRng = rng.fork("harmony");
  for (let bar = 0; bar < totalBars; bar++) {
    const sec = barToSection[bar]!;
    const vel = profile.velocity * 0.72 * sec.dynamic * (0.7 + 0.3 * sec.density);
    harmony.push(...harmonyBar(bar, voicings[bar]!, sec.harmony, vel, harmRng, profile.swing));
  }

  // --- bass: style + dynamics per section ---
  const bass: Note[] = [];
  for (let bar = 0; bar < totalBars; bar++) {
    const sec = barToSection[bar]!;
    bass.push(
      ...bassBar(bar, chordRoots[bar]!, key, sec.bass, profile.velocity * 0.9 * sec.dynamic),
    );
  }

  // --- pad: chord held across 2 bars (song-wide bed; clamped at loop end) ---
  const pad: Note[] = [];
  if (profile.layers.pad) {
    for (let bar = 0; bar < totalBars; bar += 2) {
      const v = voicings[bar]!;
      const dur = Math.min(8, (totalBars - bar) * BEATS_PER_BAR);
      for (const m of v)
        pad.push({
          startBeat: bar * 4,
          durBeats: dur,
          midi: m + 12,
          velocity: profile.velocity * 0.45,
        });
    }
  }

  // --- arp: chord tones in eighths, only in sections with arp enabled ---
  const arp: Note[] = [];
  if (profile.layers.arp) {
    const arpRng = rng.fork("arp");
    const updown = arpRng.chance(0.5);
    for (let bar = 0; bar < totalBars; bar++) {
      if (!barToSection[bar]!.arp) continue;
      const v = voicings[bar]!.map((m) => m + 12);
      const cycle = updown ? [0, 1, 2, 1] : [0, 1, 2, 0];
      for (let e = 0; e < 8; e++) {
        let onset = e / 2;
        if (profile.swing > 0 && e % 2 === 1) onset += profile.swing;
        arp.push({
          startBeat: bar * 4 + onset,
          durBeats: 0.45,
          midi: v[cycle[e % 4]!]!,
          velocity: clamp01(profile.velocity * 0.5 + arpRng.range(-0.04, 0.04)),
        });
      }
    }
  }

  // --- counter-line: slow scale walk; song-wide when the mood uses it ---
  const counter: Note[] = [];
  if (profile.layers.counter) {
    const ctrRng = rng.fork("counter");
    let deg = chordRoots[0]! + 7;
    for (let bar = 0; bar < totalBars; bar++) {
      const targetDeg = chordRoots[bar]! + 7;
      for (const half of [0, 2]) {
        deg += Math.sign(targetDeg - deg) || (ctrRng.chance(0.5) ? 1 : -1);
        counter.push({
          startBeat: bar * 4 + half,
          durBeats: 2.0,
          midi: degreeToMidi(key, deg, 4),
          velocity: profile.velocity * 0.4,
        });
      }
    }
  }

  // --- melody handoff: during lead rests, harmony plays a theme statement ---
  const handoff: Note[] = [];
  const handoffRng = rng.fork("handoff");
  for (const bar of handoffBars) {
    const sec = barToSection[bar]!;
    handoff.push(
      ...themeNotes(theme, key, leadOctave - 1, bar, {
        articulation: profile.articulation * 0.9,
        velocity: profile.velocity * sec.dynamic * 0.55,
        rng: handoffRng,
        swing: profile.swing,
      }),
    );
  }

  // --- percussion (GM drum keys); per-section gating, fills at section ends ---
  const KICK = 36,
    RIM = 37,
    HAT = 42,
    SHAKER = 70;
  const percussion: Note[] = [];
  if (profile.layers.percussion && params.weight !== "light") {
    for (let bar = 0; bar < totalBars; bar++) {
      const sec = barToSection[bar]!;
      if (!sec.percussion) continue;

      const b = bar * 4;
      const isFill = bar === sec.startBar + sec.bars - 1;

      if (mood === "tense") {
        percussion.push({ startBeat: b, durBeats: 0.3, midi: KICK, velocity: 0.7 });
        percussion.push({ startBeat: b + 2, durBeats: 0.3, midi: KICK, velocity: 0.55 });
        for (let e = 0; e < 8; e++)
          percussion.push({
            startBeat: b + e / 2,
            durBeats: 0.1,
            midi: HAT,
            velocity: e % 2 ? 0.25 : 0.4,
          });
        if (isFill) {
          // rapid fill on 4th beat
          for (let e = 0; e < 4; e++)
            percussion.push({
              startBeat: b + 3 + e * 0.25,
              durBeats: 0.1,
              midi: RIM,
              velocity: 0.5 + e * 0.1,
            });
        }
      } else {
        percussion.push({ startBeat: b, durBeats: 0.3, midi: KICK, velocity: 0.6 });
        percussion.push({ startBeat: b + 2.5, durBeats: 0.3, midi: KICK, velocity: 0.4 });
        percussion.push({ startBeat: b + 1, durBeats: 0.2, midi: RIM, velocity: 0.35 });
        percussion.push({ startBeat: b + 3, durBeats: 0.2, midi: RIM, velocity: 0.35 });
        for (let e = 0; e < 8; e++) {
          let onset = e / 2;
          if (profile.swing > 0 && e % 2 === 1) onset += profile.swing;
          percussion.push({
            startBeat: b + onset,
            durBeats: 0.1,
            midi: SHAKER,
            velocity: e % 2 ? 0.2 : 0.32,
          });
        }
        if (isFill) {
          for (let e = 0; e < 4; e++)
            percussion.push({
              startBeat: b + 3 + e * 0.25,
              durBeats: 0.1,
              midi: RIM,
              velocity: 0.45 + e * 0.1,
            });
        }
      }
    }
  }

  // --- loop-seam safety: keep every note inside [0, loopBeats), cap tails ---
  const sanitize = (notes: Note[]): Note[] =>
    notes
      .filter((n) => n.startBeat >= 0 && n.startBeat < loopBeatsTotal)
      .map((n) => ({
        ...n,
        durBeats: Math.max(0.05, Math.min(n.durBeats, loopBeatsTotal - n.startBeat)),
      }));

  const heavy = params.weight === "heavy";
  const tracks: Track[] = [
    {
      name: "lead",
      role: "lead",
      instrument: params.palette.lead,
      isPercussion: false,
      gainDb: 0,
      pan: 0,
      notes: sanitize(lead),
    },
    {
      name: "harmony",
      role: "harmony",
      instrument: params.palette.harmony,
      isPercussion: false,
      gainDb: heavy ? -7 : -9,
      pan: -0.25,
      notes: sanitize(harmony),
    },
    {
      name: "bass",
      role: "bass",
      instrument: params.palette.bass,
      isPercussion: false,
      gainDb: -5,
      pan: 0,
      notes: sanitize(bass),
    },
  ];
  if (pad.length)
    tracks.push({
      name: "pad",
      role: "pad",
      instrument: params.palette.pad,
      isPercussion: false,
      gainDb: heavy ? -10 : -13,
      pan: 0.2,
      notes: sanitize(pad),
    });
  if (arp.length)
    tracks.push({
      name: "arp",
      role: "arp",
      instrument: params.palette.harmony,
      isPercussion: false,
      gainDb: -12,
      pan: 0.35,
      notes: sanitize(arp),
    });
  if (counter.length)
    tracks.push({
      name: "counter",
      role: "counter",
      instrument: params.palette.pad,
      isPercussion: false,
      gainDb: -11,
      pan: -0.35,
      notes: sanitize(counter),
    });
  if (handoff.length)
    tracks.push({
      name: "handoff",
      role: "counter",
      instrument: params.palette.harmony,
      isPercussion: false,
      gainDb: -10,
      pan: 0.1,
      notes: sanitize(handoff),
    });
  if (percussion.length)
    tracks.push({
      name: "percussion",
      role: "percussion",
      instrument: "pluck",
      isPercussion: true,
      gainDb: -8,
      pan: 0,
      notes: sanitize(percussion),
    });

  return {
    id: `${params.id}-${mood}`,
    key,
    tempoBpm,
    beatsPerBar: BEATS_PER_BAR,
    loopBars: totalBars,
    tracks,
    meta: {
      subject: params.id,
      mood,
      seed: params.seed,
      theme: { degrees: theme.degrees, onsets: theme.onsets, durations: theme.durations },
    },
  };
}

export { THEME_LENGTH_BEATS };
