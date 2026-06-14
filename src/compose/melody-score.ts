/**
 * Holistic quality scoring for generated themes.
 * Used by generateTheme to pick the best of N candidates.
 */
import { trigramWeight } from "./corpus.ts";
import type { Theme } from "./theme.ts";
import type { Contour } from "../schema/params.ts";
import { degreeClass } from "../theory/theory.ts";

/** Target melodic shape (in degrees) at phrase position t in [0,1]. */
export function contourTarget(contour: Contour, t: number): number {
  switch (contour) {
    case "rising":
      return -1 + 7 * t;
    case "falling":
      return 6 - 7 * t;
    case "arch":
      return 6 * Math.sin(Math.PI * t);
    case "valley":
      return 4 - 6 * Math.sin(Math.PI * t);
    case "wave":
      return 3 * Math.sin(2 * Math.PI * t);
    case "static":
      return 0.8 * Math.sin(3 * Math.PI * t);
  }
}

/** Sum of log-probability of all degree triples under the corpus trigram model. */
function corpusLogLikelihood(degrees: number[]): number {
  let sum = 0;
  for (let i = 2; i < degrees.length; i++) {
    const p = trigramWeight(degrees[i - 2]!, degrees[i - 1]!, degrees[i]!);
    sum += Math.log(Math.max(p, 1e-9));
  }
  return sum;
}

/**
 * Fraction of leaps (|step| > 1) that are followed by a step in the
 * opposite direction (the classic leap-recovery principle).
 */
function leapResolutionRatio(degrees: number[]): number {
  let leaps = 0;
  let resolved = 0;
  for (let i = 1; i + 1 < degrees.length; i++) {
    const step = degrees[i]! - degrees[i - 1]!;
    if (Math.abs(step) <= 1) continue;
    leaps++;
    const next = degrees[i + 1]! - degrees[i]!;
    if (Math.sign(next) !== Math.sign(step)) resolved++;
  }
  return leaps === 0 ? 0.5 : resolved / leaps;
}

/**
 * Count of 3-note degree cells (mod-7, ignoring octave) that appear more
 * than once in the sequence — exact or transposed by up to ±2 diatonic steps.
 */
function motivicRepetitionCount(degrees: number[]): number {
  let count = 0;
  for (let i = 0; i + 2 < degrees.length; i++) {
    const cell = [degrees[i]!, degrees[i + 1]!, degrees[i + 2]!];
    for (let j = i + 1; j + 2 < degrees.length; j++) {
      for (const shift of [-2, -1, 0, 1, 2]) {
        if (
          degrees[j]! === cell[0]! + shift &&
          degrees[j + 1]! === cell[1]! + shift &&
          degrees[j + 2]! === cell[2]! + shift
        ) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

/**
 * Pearson correlation between the actual degree sequence and the target
 * contour values at each note's onset. Higher = better shape adherence.
 */
function contourFitScore(degrees: number[], onsets: number[], contour: Contour): number {
  const n = degrees.length;
  if (n < 2) return 0;

  const targets = onsets.map((o) => contourTarget(contour, o / 8));
  const meanDeg = degrees.reduce((a, b) => a + b, 0) / n;
  const meanTgt = targets.reduce((a, b) => a + b, 0) / n;

  let num = 0,
    varD = 0,
    varT = 0;
  for (let i = 0; i < n; i++) {
    const dd = degrees[i]! - meanDeg;
    const dt = targets[i]! - meanTgt;
    num += dd * dt;
    varD += dd * dd;
    varT += dt * dt;
  }
  const denom = Math.sqrt(varD * varT);
  return denom < 1e-9 ? 0 : num / denom;
}

/**
 * Fraction of notes on strong beats (onset divisible by 2) that land on
 * tonic-chord degrees (0, 2, 4 mod 7). Higher = better harmonic grounding.
 */
function tonicGrounding(degrees: number[], onsets: number[]): number {
  const CHORD = new Set([0, 2, 4]);
  let strong = 0,
    grounded = 0;
  for (let i = 0; i < degrees.length; i++) {
    if (onsets[i]! % 2 !== 0) continue;
    strong++;
    if (CHORD.has(degreeClass(degrees[i]!))) grounded++;
  }
  return strong === 0 ? 0.5 : grounded / strong;
}

/** Combined quality score for a complete theme. Higher is better. */
export function scoreTheme(theme: Theme, contour: Contour): number {
  return (
    corpusLogLikelihood(theme.degrees) * 1.0 +
    leapResolutionRatio(theme.degrees) * 3.0 +
    motivicRepetitionCount(theme.degrees) * 2.0 +
    contourFitScore(theme.degrees, theme.onsets, contour) * 1.0 +
    tonicGrounding(theme.degrees, theme.onsets) * 1.5
  );
}
