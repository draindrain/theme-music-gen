/**
 * Leitmotif generation. A subject's theme is a fixed 2-bar phrase —
 * scale degrees + rhythm — derived ONLY from subject params + seed,
 * never from mood. Moods re-color it (mode/tempo/arrangement) but the
 * degree/rhythm sequence is identical across moods: that is the test
 * for "recognizable".
 */
import type { CharacterParams, Contour, IntervalStyle, RhythmFeel } from "../schema/params.ts";
import { Rng } from "../util/prng.ts";

export type Episode = Theme;

export interface Theme {
  /** scale degrees relative to tonic (0 = tonic), may exceed 0..6 */
  degrees: number[];
  /** onsets in beats within the 8-beat phrase */
  onsets: number[];
  /** durations in beats */
  durations: number[];
}

const THEME_BEATS = 8;

/** Candidate rhythm cells per feel: [onset, duration][] over 8 beats. */
const RHYTHM_PATTERNS: Record<RhythmFeel, [number, number][][]> = {
  even: [
    [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1]],
    [[0, 2], [2, 1], [3, 1], [4, 2], [6, 1], [7, 1]],
    [[0, 1], [1, 1], [2, 2], [4, 1], [5, 1], [6, 2]],
  ],
  dotted: [
    [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1], [4, 1.5], [5.5, 0.5], [6, 1], [7, 1]],
    [[0, 1.5], [1.5, 0.5], [2, 2], [4, 1.5], [5.5, 0.5], [6, 2]],
    [[0, 0.75], [0.75, 0.25], [1, 1], [2, 1.5], [3.5, 0.5], [4, 1], [5, 1], [6, 2]],
  ],
  syncopated: [
    [[0, 0.75], [1, 0.5], [1.5, 1], [3, 0.5], [3.5, 1], [4.5, 0.75], [5.5, 0.5], [6, 1.5]],
    [[0, 1], [1.5, 0.5], [2, 0.75], [3.5, 1], [4.5, 0.5], [5, 1], [6.5, 1]],
    [[0.5, 0.75], [1.5, 0.5], [2, 1], [3.5, 0.75], [4.5, 0.5], [5, 0.75], [6, 0.5], [6.5, 1]],
  ],
  flowing: [
    [[0, 1], [1, 0.5], [1.5, 0.5], [2, 2], [4, 1], [5, 0.5], [5.5, 0.5], [6, 2]],
    [[0, 0.5], [0.5, 0.5], [1, 1], [2, 1], [3, 1], [4, 2], [6, 2]],
    [[0, 2], [2, 0.5], [2.5, 0.5], [3, 1], [4, 1], [5, 0.5], [5.5, 0.5], [6, 1.5]],
  ],
};

/** Target melodic shape (in degrees) at phrase position t in [0,1]. */
function contourTarget(contour: Contour, t: number): number {
  switch (contour) {
    case "rising": return -1 + 7 * t;
    case "falling": return 6 - 7 * t;
    case "arch": return 6 * Math.sin(Math.PI * t);
    case "valley": return 4 - 6 * Math.sin(Math.PI * t);
    case "wave": return 3 * Math.sin(2 * Math.PI * t);
    case "static": return 0.8 * Math.sin(3 * Math.PI * t);
  }
}

const STEP_CHOICES: Record<IntervalStyle, readonly number[]> = {
  stepwise: [-2, -1, -1, 1, 1, 2],
  mixed: [-3, -2, -1, 1, 2, 3, 4, -4],
  leapy: [-5, -4, -3, -2, 2, 3, 4, 5, 7],
};

export function generateTheme(params: CharacterParams): Theme {
  const rng = new Rng(params.seed).fork("theme");
  const pattern = rng.pick(RHYTHM_PATTERNS[params.rhythm]);
  const n = pattern.length;

  const degrees: number[] = [0]; // always anchor on the tonic
  for (let i = 1; i < n; i++) {
    const t = pattern[i]![0] / THEME_BEATS;
    const target = contourTarget(params.contour, t);
    const prev = degrees[i - 1]!;
    // score each allowed step by closeness to the contour target, pick
    // stochastically among the best few so different seeds differ
    const cands = STEP_CHOICES[params.intervals]
      .map((step) => {
        const deg = prev + step;
        if (deg < -4 || deg > 10) return null;
        return [deg, 1 / (1 + Math.abs(deg - target))] as const;
      })
      .filter((c): c is readonly [number, number] => c !== null);
    degrees.push(rng.pickWeighted(cands));
  }
  // end somewhere stable so the phrase can both repeat and cadence
  const last = degrees[n - 1]!;
  const stable = [0, 2, 4, 7].reduce((a, b) => (Math.abs(b - last) < Math.abs(a - last) ? b : a));
  degrees[n - 1] = stable;

  return {
    degrees,
    onsets: pattern.map(([o]) => o),
    durations: pattern.map(([, d]) => d),
  };
}

export const THEME_LENGTH_BEATS = THEME_BEATS;

// ---------------------------------------------------------------------------
// Episode generation — mood-specific 2-bar phrases derived from the core theme
// ---------------------------------------------------------------------------

/** Reverse the degree sequence, keep the rhythm pattern. */
function retrograde(theme: Theme): Episode {
  return {
    degrees: [...theme.degrees].reverse(),
    onsets: theme.onsets,
    durations: theme.durations,
  };
}

/** Mirror intervals around the opening note (up becomes down). */
function inversion(theme: Theme): Episode {
  const pivot = theme.degrees[0]!;
  return {
    degrees: theme.degrees.map((d) => Math.max(-4, Math.min(10, pivot - (d - pivot)))),
    onsets: theme.onsets,
    durations: theme.durations,
  };
}

/** Swap adjacent note pairs in the degree sequence. */
function permutation(theme: Theme): Episode {
  const degrees = [...theme.degrees];
  for (let i = 0; i + 1 < degrees.length; i += 2) {
    const tmp = degrees[i]!;
    degrees[i] = degrees[i + 1]!;
    degrees[i + 1] = tmp;
  }
  return { degrees, onsets: theme.onsets, durations: theme.durations };
}

/** Take a prefix of notes, shift all degrees by a small interval. */
function truncateShift(theme: Theme, rng: Rng): Episode {
  const n = Math.max(3, Math.floor(theme.degrees.length * 0.6));
  const shift = rng.pick([-2, -1, 1, 2] as const);
  return {
    degrees: theme.degrees.slice(0, n).map((d) => Math.max(-4, Math.min(10, d + shift))),
    onsets: theme.onsets.slice(0, n),
    durations: theme.durations.slice(0, n),
  };
}

/**
 * Generate a 2-bar episode derived from the core theme using one melodic
 * transform chosen by the mood-forked RNG. Call once per mood; calling twice
 * with the same rng produces two independent variants.
 */
export function generateEpisode(theme: Theme, rng: Rng): Episode {
  const transform = rng.pick(["retrograde", "inversion", "permutation", "truncate"] as const);
  switch (transform) {
    case "retrograde": return retrograde(theme);
    case "inversion": return inversion(theme);
    case "permutation": return permutation(theme);
    case "truncate": return truncateShift(theme, rng);
  }
}
