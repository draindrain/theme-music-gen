/**
 * Mood arrangement: turn a subject's fixed leitmotif into a full Score for
 * a given mood. The mood changes mode color, tempo, articulation, harmony and
 * which layers play — never the theme's degree/rhythm sequence.
 */
import type { CharacterParams, Mode, Mood } from "../schema/params.ts";
import { MODE_BRIGHTNESS_ORDER, voiceLeadTriads, degreeToMidi, type Key } from "../theory/theory.ts";
import type { Note, Score, Track } from "../score/types.ts";
import { Rng } from "../util/prng.ts";
import { generateTheme, generateEpisode, THEME_LENGTH_BEATS, type Theme } from "./theme.ts";

type HarmonyStyle = "sustained" | "offbeat" | "pulse" | "sparse";
type BassStyle = "whole" | "halves" | "pulse" | "arpeggiated";
type StructureType = "arrival" | "bookend" | "buried";

interface MoodProfile {
  /** steps along the mode-brightness ordering; negative = brighter */
  modeShift: number;
  tempoFactor: number;
  /** chord root degrees, one per bar, 4 bars (repeated) */
  progressionA: number[];
  progressionB: number[];
  /** note-length multiplier: <1 staccato, ~1 legato */
  articulation: number;
  velocity: number;
  /** lead register shift in scale degrees (7 = octave) */
  registerShift: number;
  layers: { pad: boolean; arp: boolean; counter: boolean; percussion: boolean };
  /** delay applied to off-beat eighths, in beats */
  swing: number;
  /** bars 0-7 harmony / bass style */
  harmonySectionA: HarmonyStyle;
  harmonySectionB: HarmonyStyle;
  bassSectionA: BassStyle;
  bassSectionB: BassStyle;
  /** structural archetype governing lead slot layout */
  structureType: StructureType;
  /** drop percussion in B section (bars 8-15) */
  percussionBreakdown: boolean;
}

export const MOOD_PROFILES: Record<Mood, MoodProfile> = {
  happy: {
    modeShift: -2, tempoFactor: 1.1, progressionA: [0, 4, 5, 3], progressionB: [3, 4, 0, 4],
    articulation: 0.85, velocity: 0.78, registerShift: 0,
    layers: { pad: false, arp: true, counter: false, percussion: true },
    swing: 0.08,
    harmonySectionA: "offbeat", harmonySectionB: "offbeat",
    bassSectionA: "halves", bassSectionB: "arpeggiated",
    structureType: "arrival", percussionBreakdown: false,
  },
  sad: {
    modeShift: 2, tempoFactor: 0.78, progressionA: [0, 5, 3, 4], progressionB: [5, 3, 0, 4],
    articulation: 1.02, velocity: 0.52, registerShift: -7,
    layers: { pad: true, arp: false, counter: false, percussion: false },
    swing: 0,
    harmonySectionA: "sustained", harmonySectionB: "sparse",
    bassSectionA: "whole", bassSectionB: "whole",
    structureType: "buried", percussionBreakdown: false,
  },
  tense: {
    modeShift: 3, tempoFactor: 1.04, progressionA: [0, 1, 0, 4], progressionB: [3, 1, 4, 0],
    articulation: 0.65, velocity: 0.7, registerShift: -7,
    layers: { pad: true, arp: true, counter: false, percussion: true },
    swing: 0,
    harmonySectionA: "pulse", harmonySectionB: "pulse",
    bassSectionA: "pulse", bassSectionB: "pulse",
    structureType: "buried", percussionBreakdown: false,
  },
  tender: {
    modeShift: 0, tempoFactor: 0.88, progressionA: [0, 2, 3, 0], progressionB: [5, 3, 0, 4],
    articulation: 1.0, velocity: 0.5, registerShift: 0,
    layers: { pad: true, arp: false, counter: true, percussion: false },
    swing: 0,
    harmonySectionA: "sustained", harmonySectionB: "offbeat",
    bassSectionA: "whole", bassSectionB: "halves",
    structureType: "bookend", percussionBreakdown: false,
  },
  playful: {
    modeShift: -1, tempoFactor: 1.18, progressionA: [0, 3, 0, 4], progressionB: [5, 3, 4, 0],
    articulation: 0.55, velocity: 0.74, registerShift: 0,
    layers: { pad: false, arp: true, counter: false, percussion: true },
    swing: 0.12,
    harmonySectionA: "offbeat", harmonySectionB: "sparse",
    bassSectionA: "arpeggiated", bassSectionB: "halves",
    structureType: "arrival", percussionBreakdown: true,
  },
  melancholy: {
    modeShift: 1, tempoFactor: 0.82, progressionA: [0, 5, 2, 4], progressionB: [3, 5, 0, 4],
    articulation: 0.95, velocity: 0.58, registerShift: 0,
    layers: { pad: true, arp: false, counter: true, percussion: false },
    swing: 0,
    harmonySectionA: "sustained", harmonySectionB: "sustained",
    bassSectionA: "halves", bassSectionB: "whole",
    structureType: "bookend", percussionBreakdown: false,
  },
};

const TEMPO_BPM: Record<CharacterParams["baseTempo"], number> = {
  very_slow: 63, slow: 78, medium: 96, fast: 116, very_fast: 138,
};

export function effectiveMode(base: Mode, shift: number): Mode {
  const i = MODE_BRIGHTNESS_ORDER.indexOf(base);
  const j = Math.min(MODE_BRIGHTNESS_ORDER.length - 1, Math.max(0, i + shift));
  return MODE_BRIGHTNESS_ORDER[j]!;
}

const BEATS_PER_BAR = 4;
const LOOP_BARS = 16;

// ---------------------------------------------------------------------------
// Structural archetypes — 8 slots (each 2 bars) defining what the lead plays
// ---------------------------------------------------------------------------
type SlotContent = "theme" | "episode" | "episode_var" | "frag" | "rest";

const ARCHETYPES: Record<StructureType, SlotContent[]> = {
  //           0         1           2       3             4       5       6          7
  arrival:  ["theme", "episode",  "rest", "episode_var", "frag", "rest", "episode", "theme"],
  bookend:  ["theme", "rest",     "episode", "episode",  "frag", "rest", "theme",   "theme"],
  buried:   ["episode", "episode", "rest", "theme",   "episode_var", "rest", "frag", "episode"],
};

// Per-archetype 16-bar velocity multiplier (applied on top of profile.velocity)
const VELOCITY_ENVELOPES: Record<StructureType, number[]> = {
  arrival:  [0.85, 0.85, 0.90, 0.90, 0.88, 0.92, 0.95, 0.95, 0.92, 0.95, 0.98, 1.00, 1.00, 1.00, 0.98, 0.95],
  bookend:  [1.00, 0.95, 0.88, 0.82, 0.78, 0.80, 0.85, 0.88, 0.90, 0.88, 0.85, 0.85, 0.90, 0.95, 1.00, 1.00],
  buried:   [0.75, 0.78, 0.82, 0.80, 0.88, 0.90, 0.95, 1.00, 0.95, 0.92, 0.85, 0.82, 0.80, 0.78, 0.75, 0.72],
};

// ---------------------------------------------------------------------------
// Note helpers
// ---------------------------------------------------------------------------

/** Place the theme's notes starting at a bar, with optional degree offset. */
function themeNotes(
  theme: Theme, key: Key, octave: number, startBar: number,
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
  theme: Theme, key: Key, octave: number, startBar: number, degreeOffset: number,
  profile: MoodProfile, rng: Rng,
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
  bar: number, voicing: number[], style: HarmonyStyle,
  vel: number, rng: Rng, swing: number,
): Note[] {
  const out: Note[] = [];
  const b = bar * BEATS_PER_BAR;
  if (style === "sustained") {
    for (const m of voicing)
      out.push({ startBeat: b, durBeats: 4.0, midi: m, velocity: clamp01(vel + rng.range(-0.04, 0.04)) });
  } else if (style === "offbeat") {
    for (const beat of [1, 3])
      for (const m of voicing)
        out.push({ startBeat: b + beat, durBeats: 0.6, midi: m, velocity: clamp01(vel + rng.range(-0.04, 0.04)) });
  } else if (style === "pulse") {
    for (let e = 0; e < 8; e += 2)
      for (const m of voicing)
        out.push({ startBeat: b + e / 2, durBeats: 0.3, midi: m, velocity: clamp01(vel * (e % 4 === 0 ? 1 : 0.8)) });
  } else {
    // sparse: beat 1 of every other bar only
    if (bar % 2 === 0)
      for (const m of voicing)
        out.push({ startBeat: b, durBeats: 3.8, midi: m, velocity: clamp01(vel * 0.85 + rng.range(-0.04, 0.04)) });
  }
  void swing;
  return out;
}

function bassBar(
  bar: number, chordRoot: number, key: Key, style: BassStyle, vel: number,
): Note[] {
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
      out.push({ startBeat: b + 2, durBeats: 1.8, midi: bar % 2 ? fifthMidi : rootMidi, velocity: vel * 0.9 });
      break;
    case "pulse":
      for (let e = 0; e < 8; e++)
        out.push({ startBeat: b + e / 2, durBeats: 0.4, midi: rootMidi, velocity: vel * (e % 2 ? 0.75 : 1) });
      break;
    case "arpeggiated": {
      const tones = [rootMidi, fifthMidi, rootMidi + 12, fifthMidi];
      for (let q = 0; q < 4; q++)
        out.push({ startBeat: b + q, durBeats: 0.7, midi: tones[q]!, velocity: vel * (q === 0 ? 1 : 0.85) });
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
  const rng = new Rng(params.seed).fork(`arr:${mood}`);
  const key: Key = { tonic: params.key.tonic, mode: effectiveMode(params.key.mode, profile.modeShift) };
  const tempoBpm = Math.round(TEMPO_BPM[params.baseTempo] * profile.tempoFactor);

  const leadOctave =
    5 + (params.brightness === "bright" ? 0 : params.brightness === "dark" ? -1 : 0) +
    Math.round(profile.registerShift / 7);

  // --- chord plan: one root degree per bar across the 16-bar loop ---
  const chordRoots: number[] = [
    ...profile.progressionA, ...profile.progressionA,
    ...profile.progressionB, ...profile.progressionB,
  ];

  // --- episodes: two variants derived from the theme via the mood-forked rng ---
  const episodeRng = rng.fork("episode");
  const episode = generateEpisode(theme, episodeRng);
  const episodeVar = generateEpisode(theme, episodeRng);

  const velEnv = VELOCITY_ENVELOPES[profile.structureType];
  const archetype = ARCHETYPES[profile.structureType];

  // --- lead: iterate 8 structural slots (each 2 bars) ---
  const leadRng = rng.fork("lead");
  const lead: Note[] = [];
  const restBars = new Set<number>(); // bars where lead is silent

  for (let slot = 0; slot < 8; slot++) {
    const startBar = slot * 2;
    const slotContent = archetype[slot]!;
    const vel = profile.velocity * velEnv[startBar]!;

    switch (slotContent) {
      case "theme":
        lead.push(...themeNotes(theme, key, leadOctave, startBar, {
          articulation: profile.articulation, velocity: vel, rng: leadRng, swing: profile.swing,
        }));
        break;
      case "episode":
        lead.push(...themeNotes(episode, key, leadOctave, startBar, {
          articulation: profile.articulation, velocity: vel * 0.95, rng: leadRng, swing: profile.swing,
        }));
        break;
      case "episode_var":
        lead.push(...themeNotes(episodeVar, key, leadOctave, startBar, {
          articulation: profile.articulation, velocity: vel * 0.95, rng: leadRng, swing: profile.swing,
        }));
        break;
      case "frag":
        lead.push(...fragmentNotes(theme, key, leadOctave, startBar, 0, profile, leadRng));
        break;
      case "rest":
        restBars.add(startBar);
        restBars.add(startBar + 1);
        break;
    }
  }

  // --- harmony: voice-led triads with A/B section styles ---
  const voicings = voiceLeadTriads(key, chordRoots, 4);
  const harmony: Note[] = [];
  const harmRng = rng.fork("harmony");
  for (let bar = 0; bar < LOOP_BARS; bar++) {
    const v = voicings[bar]!;
    const vel = profile.velocity * 0.72;
    const style = bar < 8 ? profile.harmonySectionA : profile.harmonySectionB;
    harmony.push(...harmonyBar(bar, v, style, vel, harmRng, profile.swing));
  }

  // --- bass: A/B section styles ---
  const bass: Note[] = [];
  for (let bar = 0; bar < LOOP_BARS; bar++) {
    const style = bar < 8 ? profile.bassSectionA : profile.bassSectionB;
    bass.push(...bassBar(bar, chordRoots[bar]!, key, style, profile.velocity * 0.9));
  }

  // --- pad: chord held across 2 bars ---
  const pad: Note[] = [];
  if (profile.layers.pad) {
    for (let bar = 0; bar < LOOP_BARS; bar += 2) {
      const v = voicings[bar]!;
      for (const m of v)
        pad.push({ startBeat: bar * 4, durBeats: 8, midi: m + 12, velocity: profile.velocity * 0.45 });
    }
  }

  // --- arp: chord tones in eighths, bars 4-11 only ---
  const arp: Note[] = [];
  if (profile.layers.arp) {
    const arpRng = rng.fork("arp");
    const updown = arpRng.chance(0.5);
    for (let bar = 4; bar < 12; bar++) {
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

  // --- counter-line: slow scale walk; picks up melody handoff during lead rests ---
  const counter: Note[] = [];
  if (profile.layers.counter) {
    const ctrRng = rng.fork("counter");
    let deg = chordRoots[0]! + 7;
    for (let bar = 0; bar < LOOP_BARS; bar++) {
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

  // --- melody handoff: on rest bars, harmony instrument plays a theme fragment ---
  const handoff: Note[] = [];
  const handoffRng = rng.fork("handoff");
  for (const bar of restBars) {
    handoff.push(...themeNotes(theme, key, leadOctave - 1, bar, {
      articulation: profile.articulation * 0.9,
      velocity: profile.velocity * velEnv[bar]! * 0.55,
      rng: handoffRng,
      swing: profile.swing,
    }));
  }

  // --- percussion (GM drum keys) ---
  const KICK = 36, RIM = 37, HAT = 42, SHAKER = 70;
  const percussion: Note[] = [];
  if (profile.layers.percussion && params.weight !== "light") {
    for (let bar = 0; bar < LOOP_BARS; bar++) {
      // Breakdown: drop percussion in B section for some moods
      if (profile.percussionBreakdown && bar >= 8) continue;

      const b = bar * 4;
      const isFill = bar === 7 || bar === 15;

      if (mood === "tense") {
        percussion.push({ startBeat: b, durBeats: 0.3, midi: KICK, velocity: 0.7 });
        percussion.push({ startBeat: b + 2, durBeats: 0.3, midi: KICK, velocity: 0.55 });
        for (let e = 0; e < 8; e++)
          percussion.push({ startBeat: b + e / 2, durBeats: 0.1, midi: HAT, velocity: e % 2 ? 0.25 : 0.4 });
        if (isFill) {
          // rapid fill on 4th beat
          for (let e = 0; e < 4; e++)
            percussion.push({ startBeat: b + 3 + e * 0.25, durBeats: 0.1, midi: RIM, velocity: 0.5 + e * 0.1 });
        }
      } else {
        percussion.push({ startBeat: b, durBeats: 0.3, midi: KICK, velocity: 0.6 });
        percussion.push({ startBeat: b + 2.5, durBeats: 0.3, midi: KICK, velocity: 0.4 });
        percussion.push({ startBeat: b + 1, durBeats: 0.2, midi: RIM, velocity: 0.35 });
        percussion.push({ startBeat: b + 3, durBeats: 0.2, midi: RIM, velocity: 0.35 });
        for (let e = 0; e < 8; e++) {
          let onset = e / 2;
          if (profile.swing > 0 && e % 2 === 1) onset += profile.swing;
          percussion.push({ startBeat: b + onset, durBeats: 0.1, midi: SHAKER, velocity: e % 2 ? 0.2 : 0.32 });
        }
        if (isFill) {
          for (let e = 0; e < 4; e++)
            percussion.push({ startBeat: b + 3 + e * 0.25, durBeats: 0.1, midi: RIM, velocity: 0.45 + e * 0.1 });
        }
      }
    }
  }

  const heavy = params.weight === "heavy";
  const tracks: Track[] = [
    { name: "lead", role: "lead", instrument: params.palette.lead, isPercussion: false, gainDb: 0, pan: 0, notes: lead },
    { name: "harmony", role: "harmony", instrument: params.palette.harmony, isPercussion: false, gainDb: heavy ? -7 : -9, pan: -0.25, notes: harmony },
    { name: "bass", role: "bass", instrument: params.palette.bass, isPercussion: false, gainDb: -5, pan: 0, notes: bass },
  ];
  if (pad.length) tracks.push({ name: "pad", role: "pad", instrument: params.palette.pad, isPercussion: false, gainDb: heavy ? -10 : -13, pan: 0.2, notes: pad });
  if (arp.length) tracks.push({ name: "arp", role: "arp", instrument: params.palette.harmony, isPercussion: false, gainDb: -12, pan: 0.35, notes: arp });
  if (counter.length) tracks.push({ name: "counter", role: "counter", instrument: params.palette.pad, isPercussion: false, gainDb: -11, pan: -0.35, notes: counter });
  if (handoff.length) tracks.push({ name: "handoff", role: "counter", instrument: params.palette.harmony, isPercussion: false, gainDb: -10, pan: 0.1, notes: handoff });
  if (percussion.length) tracks.push({ name: "percussion", role: "percussion", instrument: "pluck", isPercussion: true, gainDb: -8, pan: 0, notes: percussion });

  return {
    id: `${params.id}-${mood}`,
    key,
    tempoBpm,
    beatsPerBar: BEATS_PER_BAR,
    loopBars: LOOP_BARS,
    tracks,
    meta: { subject: params.id, mood, seed: params.seed, theme: { degrees: theme.degrees, onsets: theme.onsets, durations: theme.durations } },
  };
}

export { THEME_LENGTH_BEATS };
