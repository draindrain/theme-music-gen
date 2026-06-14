/**
 * Leitmotif generation. A subject's theme is a fixed 2-bar phrase —
 * scale degrees + rhythm — derived ONLY from subject params + seed,
 * never from mood. Moods re-color it (mode/tempo/arrangement) but the
 * degree/rhythm sequence is identical across moods: that is the test
 * for "recognizable".
 */
import type { CharacterParams, IntervalStyle, RhythmFeel } from "../schema/params.ts";
import { degreeClass } from "../theory/theory.ts";
import { Rng } from "../util/prng.ts";
import { bigramWeight, trigramWeight } from "./corpus.ts";
import { contourTarget, scoreTheme } from "./melody-score.ts";

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
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 1],
    ],
    [
      [0, 2],
      [2, 1],
      [3, 1],
      [4, 2],
      [6, 1],
      [7, 1],
    ],
    [
      [0, 1],
      [1, 1],
      [2, 2],
      [4, 1],
      [5, 1],
      [6, 2],
    ],
  ],
  dotted: [
    [
      [0, 1.5],
      [1.5, 0.5],
      [2, 1],
      [3, 1],
      [4, 1.5],
      [5.5, 0.5],
      [6, 1],
      [7, 1],
    ],
    [
      [0, 1.5],
      [1.5, 0.5],
      [2, 2],
      [4, 1.5],
      [5.5, 0.5],
      [6, 2],
    ],
    [
      [0, 0.75],
      [0.75, 0.25],
      [1, 1],
      [2, 1.5],
      [3.5, 0.5],
      [4, 1],
      [5, 1],
      [6, 2],
    ],
  ],
  syncopated: [
    [
      [0, 0.75],
      [1, 0.5],
      [1.5, 1],
      [3, 0.5],
      [3.5, 1],
      [4.5, 0.75],
      [5.5, 0.5],
      [6, 1.5],
    ],
    [
      [0, 1],
      [1.5, 0.5],
      [2, 0.75],
      [3.5, 1],
      [4.5, 0.5],
      [5, 1],
      [6.5, 1],
    ],
    [
      [0.5, 0.75],
      [1.5, 0.5],
      [2, 1],
      [3.5, 0.75],
      [4.5, 0.5],
      [5, 0.75],
      [6, 0.5],
      [6.5, 1],
    ],
  ],
  flowing: [
    [
      [0, 1],
      [1, 0.5],
      [1.5, 0.5],
      [2, 2],
      [4, 1],
      [5, 0.5],
      [5.5, 0.5],
      [6, 2],
    ],
    [
      [0, 0.5],
      [0.5, 0.5],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [6, 2],
    ],
    [
      [0, 2],
      [2, 0.5],
      [2.5, 0.5],
      [3, 1],
      [4, 1],
      [5, 0.5],
      [5.5, 0.5],
      [6, 1.5],
    ],
  ],
};

const STEP_CHOICES: Record<IntervalStyle, readonly number[]> = {
  stepwise: [-2, -1, -1, 1, 1, 2],
  mixed: [-3, -2, -1, 1, 2, 3, 4, -4],
  leapy: [-5, -4, -3, -2, 2, 3, 4, 5, 7],
};

// Stable scale degrees (tonic / mediant / dominant — safe landing spots)
const STABLE_DEGREES = new Set([0, 2, 4]);

function isStable(deg: number): boolean {
  return STABLE_DEGREES.has(degreeClass(deg));
}

/**
 * Generate one candidate theme from a given RNG stream.
 * Used by generateTheme to produce N candidates for scoring.
 */
function generateOnce(
  rng: Rng,
  pattern: readonly (readonly [number, number])[],
  params: CharacterParams,
): Theme {
  const n = pattern.length;
  const midpoint = Math.ceil(n / 2);

  const degrees: number[] = [0]; // always anchor on tonic

  for (let i = 1; i < n; i++) {
    const [onset, dur] = pattern[i]!;
    const t = onset / THEME_BEATS;
    const target = contourTarget(params.contour, t);
    const prev = degrees[i - 1]!;
    const prevPrev = i >= 2 ? degrees[i - 2]! : undefined;

    // Seed motif for motivic repetition: degrees[1..3] (first 3 notes after tonic)
    const motif = degrees.slice(1, 4);
    const inSecondHalf = i >= midpoint && motif.length >= 2;

    const cands = STEP_CHOICES[params.intervals]
      .map((step) => {
        const deg = prev + step;
        if (deg < -4 || deg > 10) return null;

        // --- contour closeness (primary shape driver, unchanged) ---
        const contourW = 1 / (1 + Math.abs(deg - target));

        // --- corpus probability (soft nudge via sqrt; 4x advantage → 2x weight) ---
        const corpus =
          prevPrev !== undefined ? trigramWeight(prevPrev, prev, deg) : bigramWeight(prev, deg);
        const corpusW = Math.sqrt(corpus);

        // --- duration bias: short notes can be passing tones, long notes want to be structural ---
        const stable = isStable(deg);
        const durationW =
          dur < 0.5 ? (stable ? 0.6 : 1.6) : dur >= 1.5 ? (stable ? 2.0 : 0.5) : 1.0;

        // --- beat weight: strong beats (1,3,5,7) favour stable degrees ---
        const beatW =
          onset % 1 !== 0
            ? stable
              ? 0.7
              : 1.3 // offbeat
            : onset % 2 === 0
              ? stable
                ? 1.5
                : 0.7 // strong beat
              : 1.0; // weak beat (2,4,6)

        // --- motivic repetition: second half biases toward the opening cell ---
        let motifW = 1.0;
        if (inSecondHalf && motif.length > 0) {
          const motifIdx = (i - midpoint) % motif.length;
          const cell = motif[motifIdx]!;
          if (deg === cell || deg === cell + 1 || deg === cell - 1) {
            motifW = 2.5;
          }
        }

        return [deg, contourW * corpusW * durationW * beatW * motifW] as const;
      })
      .filter((c): c is readonly [number, number] => c !== null);

    degrees.push(rng.pickWeighted(cands));
  }

  // Snap last note to closest stable degree so the phrase can cadence cleanly
  const last = degrees[n - 1]!;
  const stable = [0, 2, 4, 7].reduce((a, b) => (Math.abs(b - last) < Math.abs(a - last) ? b : a));
  degrees[n - 1] = stable;

  return {
    degrees,
    onsets: pattern.map(([o]) => o),
    durations: pattern.map(([, d]) => d),
  };
}

const CANDIDATES = 12;

export function generateTheme(params: CharacterParams): Theme {
  const rng = new Rng(params.seed).fork("theme");
  const pattern = rng.pick(RHYTHM_PATTERNS[params.rhythm]);

  // Generate N candidates, each with its own deterministic RNG fork.
  // Same seed → same candidates → same winner every time.
  const candidates = Array.from({ length: CANDIDATES }, (_, c) =>
    generateOnce(rng.fork(`cand${c}`), pattern, params),
  );

  return candidates.reduce((best, cand) =>
    scoreTheme(cand, params.contour) > scoreTheme(best, params.contour) ? cand : best,
  );
}

export const THEME_LENGTH_BEATS = THEME_BEATS;

// ---------------------------------------------------------------------------
// Episode generation — mood-specific 2-bar phrases derived from the core theme
// ---------------------------------------------------------------------------

/** Threshold below which a trigram transition is considered un-idiomatic. */
const REPAIR_THRESHOLD = 0.04;

/**
 * Nudge any note whose trigram probability falls below REPAIR_THRESHOLD to the
 * nearest ±1 neighbor that scores better, keeping degrees in [-4, 10].
 */
function repairEpisode(episode: Episode): Episode {
  const degrees = [...episode.degrees];
  for (let i = 2; i < degrees.length; i++) {
    const w = trigramWeight(degrees[i - 2]!, degrees[i - 1]!, degrees[i]!);
    if (w < REPAIR_THRESHOLD) {
      const curr = degrees[i]!;
      const neighbors = [curr - 1, curr + 1].filter((d) => d >= -4 && d <= 10);
      const best = neighbors.reduce(
        (a, b) =>
          trigramWeight(degrees[i - 2]!, degrees[i - 1]!, b) >
          trigramWeight(degrees[i - 2]!, degrees[i - 1]!, a)
            ? b
            : a,
        curr,
      );
      if (trigramWeight(degrees[i - 2]!, degrees[i - 1]!, best) > w) {
        degrees[i] = best;
      }
    }
  }
  return { ...episode, degrees };
}

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
 * Diatonic sequence: split the phrase in half and shift the second half up by
 * two scale steps. Reuses the original onsets/durations to avoid any timing
 * arithmetic that could push notes outside the 8-beat phrase window.
 */
function sequence(theme: Theme): Episode {
  const half = Math.ceil(theme.degrees.length / 2);
  const degrees = [
    ...theme.degrees.slice(0, half),
    ...theme.degrees.slice(half).map((d) => Math.max(-4, Math.min(10, d + 2))),
  ];
  return { degrees, onsets: [...theme.onsets], durations: [...theme.durations] };
}

/**
 * Generate a 2-bar episode derived from the core theme using one melodic
 * transform chosen by the mood-forked RNG. Call once per mood; calling twice
 * with the same rng produces two independent variants.
 */
export function generateEpisode(theme: Theme, rng: Rng): Episode {
  const transform = rng.pick(["retrograde", "inversion", "sequence", "truncate"] as const);
  let episode: Episode;
  switch (transform) {
    case "retrograde":
      episode = retrograde(theme);
      break;
    case "inversion":
      episode = inversion(theme);
      break;
    case "sequence":
      episode = sequence(theme);
      break;
    case "truncate":
      episode = truncateShift(theme, rng);
      break;
  }
  return repairEpisode(episode);
}
