/**
 * Scales, diatonic chords and voice leading. All composition stays inside
 * these helpers so "every pitched note is in the declared scale" is a
 * structural property, testable on the Score IR.
 */
import { MODES, PITCH_CLASSES, type Mode, type PitchClass } from "../schema/params.ts";

export const MODE_INTERVALS: Record<Mode, readonly number[]> = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

/** Brightness ordering used by mood transforms (0 = brightest). */
export const MODE_BRIGHTNESS_ORDER: readonly Mode[] = MODES;

export function pitchClassIndex(pc: PitchClass): number {
  return PITCH_CLASSES.indexOf(pc);
}

export interface Key {
  tonic: PitchClass;
  mode: Mode;
}

/** Set of pitch classes (0-11) in a key. */
export function scalePitchClasses(key: Key): Set<number> {
  const root = pitchClassIndex(key.tonic);
  return new Set(MODE_INTERVALS[key.mode].map((iv) => (root + iv) % 12));
}

/**
 * Map a scale degree (integer, may be negative or >6 for other octaves)
 * to a MIDI note. degree 0 at `octave` is the tonic.
 */
export function degreeToMidi(key: Key, degree: number, octave: number): number {
  const ivs = MODE_INTERVALS[key.mode];
  const oct = Math.floor(degree / 7);
  const step = ((degree % 7) + 7) % 7;
  return 12 * (octave + 1 + oct) + pitchClassIndex(key.tonic) + ivs[step]!;
}

/** Diatonic triad on a scale degree: [root, third, fifth] as degree numbers. */
export function triadDegrees(rootDegree: number): [number, number, number] {
  return [rootDegree, rootDegree + 2, rootDegree + 4];
}

export function triadMidi(key: Key, rootDegree: number, octave: number): number[] {
  return triadDegrees(rootDegree).map((d) => degreeToMidi(key, d, octave));
}

/**
 * Voice-lead a sequence of triads: keep three voices, each chord voiced as the
 * inversion (within +/-1 octave shifts) minimizing total movement from the
 * previous voicing. Returns one midi[3] per chord.
 */
export function voiceLeadTriads(
  key: Key,
  rootDegrees: readonly number[],
  octave: number,
): number[][] {
  const out: number[][] = [];
  let prev: number[] | null = null;
  for (const rd of rootDegrees) {
    const base = triadMidi(key, rd, octave);
    if (!prev) {
      out.push(base);
      prev = base;
      continue;
    }
    let best: number[] = base;
    let bestCost = Infinity;
    // candidate voicings: each chord tone moved by -12/0/+12, keep sorted sets
    for (const a of [-12, 0, 12])
      for (const b of [-12, 0, 12])
        for (const c of [-12, 0, 12]) {
          const cand = [base[0]! + a, base[1]! + b, base[2]! + c].sort((x, y) => x - y);
          const sortedPrev = [...prev].sort((x, y) => x - y);
          let cost = 0;
          for (let i = 0; i < 3; i++) cost += Math.abs(cand[i]! - sortedPrev[i]!);
          // keep voicings in a sane register
          if (cand[0]! < degreeToMidi(key, 0, octave) - 14) cost += 100;
          if (cand[2]! > degreeToMidi(key, 0, octave) + 26) cost += 100;
          if (cost < bestCost) {
            bestCost = cost;
            best = cand;
          }
        }
    out.push(best);
    prev = best;
  }
  return out;
}

/** Max per-voice movement between consecutive voicings (for tests). */
export function maxVoiceMovement(voicings: readonly number[][]): number {
  let max = 0;
  for (let i = 1; i < voicings.length; i++) {
    const a = [...voicings[i - 1]!].sort((x, y) => x - y);
    const b = [...voicings[i]!].sort((x, y) => x - y);
    for (let v = 0; v < a.length; v++) max = Math.max(max, Math.abs(a[v]! - b[v]!));
  }
  return max;
}
