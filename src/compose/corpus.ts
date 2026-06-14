/**
 * Melody transition corpus derived from the Essen Folksong Collection.
 * Provides bigram and trigram probability lookups over scale degrees 0–6.
 *
 * Tables were built by scripts/build-corpus.ts and are committed to avoid
 * any network dependency at runtime.
 */
import data from "./corpus-data.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Phrase-form templates — high-level song structure mined from the corpus.
// ---------------------------------------------------------------------------

export interface FormTemplate {
  /** repetition signature, e.g. "AABA", "ABAC", "AAB", "TC" (through-composed) */
  form: string;
  /** bars in each phrase, parallel to the form string */
  barsPerPhrase: number[];
  /** total bars = sum(barsPerPhrase) */
  totalBars: number;
  /** observation count in the corpus, used as a sampling weight */
  weight: number;
}

export interface CorpusData {
  bigrams: number[][];
  trigrams: number[][][];
  formTemplates?: FormTemplate[];
}

/**
 * Canonical folk/popular phrase forms, used when the corpus JSON predates the
 * form-template extraction (or was built offline with no network). Every entry
 * keeps totalBars in 12..32 so downstream length assumptions hold.
 */
export const FALLBACK_TEMPLATES: FormTemplate[] = [
  { form: "AABA", barsPerPhrase: [4, 4, 4, 4], totalBars: 16, weight: 40 },
  { form: "ABAB", barsPerPhrase: [4, 4, 4, 4], totalBars: 16, weight: 25 },
  { form: "ABAC", barsPerPhrase: [4, 4, 4, 4], totalBars: 16, weight: 20 },
  { form: "ABA", barsPerPhrase: [4, 4, 4], totalBars: 12, weight: 18 },
  { form: "AAB", barsPerPhrase: [4, 4, 8], totalBars: 16, weight: 15 },
  { form: "AABB", barsPerPhrase: [4, 4, 4, 4], totalBars: 16, weight: 12 },
  { form: "ABCA", barsPerPhrase: [4, 4, 4, 4], totalBars: 16, weight: 10 },
  { form: "ABACA", barsPerPhrase: [4, 4, 4, 4, 4], totalBars: 20, weight: 8 },
  { form: "AABACA", barsPerPhrase: [4, 4, 4, 4, 4, 4], totalBars: 24, weight: 8 },
  { form: "TC", barsPerPhrase: [4, 4, 4, 4, 4, 4, 4, 4], totalBars: 32, weight: 6 },
];

/** Weighted catalog of phrase-form templates, from the corpus or the fallback. */
export function formTemplates(): FormTemplate[] {
  const fromData = (data as CorpusData).formTemplates;
  return fromData && fromData.length > 0 ? fromData : FALLBACK_TEMPLATES;
}

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
