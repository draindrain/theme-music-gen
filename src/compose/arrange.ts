/**
 * Mood arrangement: turn a character's fixed leitmotif into a full Score for
 * a given mood. The mood changes mode color, tempo, articulation, harmony and
 * which layers play — never the theme's degree/rhythm sequence.
 */
import type { CharacterParams, Mode, Mood } from "../schema/params.ts";
import { MODE_BRIGHTNESS_ORDER, voiceLeadTriads, degreeToMidi, type Key } from "../theory/theory.ts";
import type { Note, Score, Track } from "../score/types.ts";
import { Rng } from "../util/prng.ts";
import { generateTheme, THEME_LENGTH_BEATS, type Theme } from "./theme.ts";

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
  harmonyStyle: "sustained" | "offbeat" | "pulse";
  bassStyle: "whole" | "halves" | "pulse" | "arpeggiated";
}

export const MOOD_PROFILES: Record<Mood, MoodProfile> = {
  happy: {
    modeShift: -2, tempoFactor: 1.1, progressionA: [0, 4, 5, 3], progressionB: [3, 4, 0, 4],
    articulation: 0.85, velocity: 0.78, registerShift: 0,
    layers: { pad: false, arp: true, counter: false, percussion: true },
    swing: 0.08, harmonyStyle: "offbeat", bassStyle: "halves",
  },
  sad: {
    modeShift: 2, tempoFactor: 0.78, progressionA: [0, 5, 3, 4], progressionB: [5, 3, 0, 4],
    articulation: 1.02, velocity: 0.52, registerShift: -7,
    layers: { pad: true, arp: false, counter: false, percussion: false },
    swing: 0, harmonyStyle: "sustained", bassStyle: "whole",
  },
  tense: {
    modeShift: 3, tempoFactor: 1.04, progressionA: [0, 1, 0, 4], progressionB: [3, 1, 4, 0],
    articulation: 0.65, velocity: 0.7, registerShift: -7,
    layers: { pad: true, arp: true, counter: false, percussion: true },
    swing: 0, harmonyStyle: "pulse", bassStyle: "pulse",
  },
  tender: {
    modeShift: 0, tempoFactor: 0.88, progressionA: [0, 2, 3, 0], progressionB: [5, 3, 0, 4],
    articulation: 1.0, velocity: 0.5, registerShift: 0,
    layers: { pad: true, arp: false, counter: true, percussion: false },
    swing: 0, harmonyStyle: "sustained", bassStyle: "whole",
  },
  playful: {
    modeShift: -1, tempoFactor: 1.18, progressionA: [0, 3, 0, 4], progressionB: [5, 3, 4, 0],
    articulation: 0.55, velocity: 0.74, registerShift: 0,
    layers: { pad: false, arp: true, counter: false, percussion: true },
    swing: 0.12, harmonyStyle: "offbeat", bassStyle: "arpeggiated",
  },
  melancholy: {
    modeShift: 1, tempoFactor: 0.82, progressionA: [0, 5, 2, 4], progressionB: [3, 5, 0, 4],
    articulation: 0.95, velocity: 0.58, registerShift: 0,
    layers: { pad: true, arp: false, counter: true, percussion: false },
    swing: 0, harmonyStyle: "sustained", bassStyle: "halves",
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

  // --- lead: theme statements with light development ---
  const leadRng = rng.fork("lead");
  const lead: Note[] = [
    // A section: theme x4 (3rd statement up a third for lift)
    ...themeNotes(theme, key, leadOctave, 0, { articulation: profile.articulation, velocity: profile.velocity, rng: leadRng, swing: profile.swing }),
    ...themeNotes(theme, key, leadOctave, 2, { articulation: profile.articulation, velocity: profile.velocity - 0.05, rng: leadRng, swing: profile.swing }),
    ...themeNotes(theme, key, leadOctave, 4, { degreeOffset: 2, articulation: profile.articulation, velocity: profile.velocity, rng: leadRng, swing: profile.swing }),
    ...themeNotes(theme, key, leadOctave, 6, { articulation: profile.articulation, velocity: profile.velocity + 0.05, rng: leadRng, swing: profile.swing }),
    // B section: fragment development — first half of the theme, sequenced
    ...fragmentNotes(theme, key, leadOctave, 8, 2, profile, leadRng),
    ...fragmentNotes(theme, key, leadOctave, 10, 1, profile, leadRng),
    ...fragmentNotes(theme, key, leadOctave, 12, -1, profile, leadRng),
    // final statement leading back to the top
    ...themeNotes(theme, key, leadOctave, 14, { articulation: profile.articulation, velocity: profile.velocity, rng: leadRng, swing: profile.swing }),
  ];

  // --- harmony: voice-led triads ---
  const voicings = voiceLeadTriads(key, chordRoots, 4);
  const harmony: Note[] = [];
  const harmRng = rng.fork("harmony");
  for (let bar = 0; bar < LOOP_BARS; bar++) {
    const v = voicings[bar]!;
    const vel = profile.velocity * 0.72;
    if (profile.harmonyStyle === "sustained") {
      for (const m of v)
        harmony.push({ startBeat: bar * 4, durBeats: 4.0, midi: m, velocity: clamp01(vel + harmRng.range(-0.04, 0.04)) });
    } else if (profile.harmonyStyle === "offbeat") {
      for (const b of [1, 3])
        for (const m of v)
          harmony.push({ startBeat: bar * 4 + b + (profile.swing > 0 ? 0 : 0), durBeats: 0.6, midi: m, velocity: clamp01(vel + harmRng.range(-0.04, 0.04)) });
    } else {
      // pulse: repeated eighth-note stabs
      for (let e = 0; e < 8; e += 2)
        for (const m of v)
          harmony.push({ startBeat: bar * 4 + e / 2, durBeats: 0.3, midi: m, velocity: clamp01(vel * (e % 4 === 0 ? 1 : 0.8)) });
    }
  }

  // --- bass ---
  const bass: Note[] = [];
  const bassRng = rng.fork("bass");
  for (let bar = 0; bar < LOOP_BARS; bar++) {
    const root = chordRoots[bar]!;
    const rootMidi = degreeToMidi(key, root, 2);
    const fifthMidi = degreeToMidi(key, root + 4, 2);
    const vel = profile.velocity * 0.9;
    switch (profile.bassStyle) {
      case "whole":
        bass.push({ startBeat: bar * 4, durBeats: 4, midi: rootMidi, velocity: vel });
        break;
      case "halves":
        bass.push({ startBeat: bar * 4, durBeats: 1.8, midi: rootMidi, velocity: vel });
        bass.push({ startBeat: bar * 4 + 2, durBeats: 1.8, midi: bar % 2 ? fifthMidi : rootMidi, velocity: vel * 0.9 });
        break;
      case "pulse":
        for (let e = 0; e < 8; e++)
          bass.push({ startBeat: bar * 4 + e / 2, durBeats: 0.4, midi: rootMidi, velocity: vel * (e % 2 ? 0.75 : 1) });
        break;
      case "arpeggiated": {
        const tones = [rootMidi, fifthMidi, rootMidi + 12, fifthMidi];
        for (let q = 0; q < 4; q++)
          bass.push({ startBeat: bar * 4 + q, durBeats: 0.7, midi: tones[q]!, velocity: vel * (q === 0 ? 1 : 0.85) });
        break;
      }
    }
    void bassRng;
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

  // --- arp: chord tones in eighths ---
  const arp: Note[] = [];
  if (profile.layers.arp) {
    const arpRng = rng.fork("arp");
    const updown = arpRng.chance(0.5);
    for (let bar = 0; bar < LOOP_BARS; bar++) {
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

  // --- counter-line: slow scale walk between chord tones, B section focus ---
  const counter: Note[] = [];
  if (profile.layers.counter) {
    const ctrRng = rng.fork("counter");
    let deg = chordRoots[0]! + 7; // an octave above the roots
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

  // --- percussion (GM drum keys) ---
  const percussion: Note[] = [];
  if (profile.layers.percussion && params.weight !== "light") {
    const KICK = 36, RIM = 37, HAT = 42, SHAKER = 70;
    for (let bar = 0; bar < LOOP_BARS; bar++) {
      const b = bar * 4;
      if (mood === "tense") {
        percussion.push({ startBeat: b, durBeats: 0.3, midi: KICK, velocity: 0.7 });
        percussion.push({ startBeat: b + 2, durBeats: 0.3, midi: KICK, velocity: 0.55 });
        for (let e = 0; e < 8; e++)
          percussion.push({ startBeat: b + e / 2, durBeats: 0.1, midi: HAT, velocity: e % 2 ? 0.25 : 0.4 });
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
  if (percussion.length) tracks.push({ name: "percussion", role: "percussion", instrument: "pluck", isPercussion: true, gainDb: -8, pan: 0, notes: percussion });

  return {
    id: `${params.id}-${mood}`,
    key,
    tempoBpm,
    beatsPerBar: BEATS_PER_BAR,
    loopBars: LOOP_BARS,
    tracks,
    meta: { character: params.id, mood, seed: params.seed, theme: { degrees: theme.degrees, onsets: theme.onsets, durations: theme.durations } },
  };
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

export { THEME_LENGTH_BEATS };
