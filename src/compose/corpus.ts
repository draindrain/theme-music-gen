/**
 * Melody transition corpus derived from the Essen Folksong Collection.
 * Provides bigram and trigram probability lookups over scale degrees 0–6.
 *
 * Tables were built by scripts/build-corpus.ts and are committed to avoid
 * any network dependency at runtime.
 */
import data from "./corpus-data.json" with { type: "json" };

function mod7(d: number): number {
  return ((d % 7) + 7) % 7;
}

/**
 * P(next | prev, curr) from the trigram table with bigram backoff.
 * All inputs are absolute scale degrees (any integer; normalized mod 7 internally).
 */
export function trigramWeight(prev: number, curr: number, next: number): number {
  const p = mod7(prev);
  const c = mod7(curr);
  const n = mod7(next);
  const tri = (data.trigrams[p] as number[][])[c]?.[n];
  if (tri !== undefined && tri > 0) return tri;
  return bigramWeight(curr, next);
}

/**
 * P(next | curr) from the bigram table.
 * All inputs are absolute scale degrees (any integer; normalized mod 7 internally).
 */
export function bigramWeight(curr: number, next: number): number {
  const c = mod7(curr);
  const n = mod7(next);
  return (data.bigrams[c] as number[])?.[n] ?? 1 / 7;
}
