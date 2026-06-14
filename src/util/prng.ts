/**
 * Deterministic seeded PRNG (mulberry32) plus string hashing.
 * Every random decision in composition/synthesis flows through this,
 * so same seed + same params => identical output.
 */

export function hashString(s: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic default seed for a description/subject id. The CLI and the web
 * studio both rely on this so an id without an explicit seed renders identically
 * in either entry point.
 */
export function defaultSeed(id: string): number {
  return hashString(id) % 0xffffffff;
}

export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = (typeof seed === "string" ? hashString(seed) : seed >>> 0) || 1;
  }

  /** Derive an independent stream, e.g. rng.fork("bass") */
  fork(label: string): Rng {
    return new Rng((this.state ^ hashString(label)) >>> 0 || 1);
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("Rng.pick on empty array");
    return arr[this.int(arr.length)]!;
  }

  /** Weighted pick; weights need not sum to 1. */
  pickWeighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    return items[items.length - 1]![0];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
