import { describe, expect, it } from "vitest";
import { Rng, hashString, defaultSeed } from "../src/util/prng.ts";

describe("hashString", () => {
  it("is deterministic and stays in the unsigned 32-bit range", () => {
    const h = hashString("elara");
    expect(h).toBe(hashString("elara"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(hashString("elara")).not.toBe(hashString("bram"));
  });
});

describe("defaultSeed", () => {
  it("derives a stable seed from an id (the formula CLI and web studio share)", () => {
    // Same id -> same seed across entry points; this is what keeps an
    // unseeded render reproducible between `pnpm compose` and the web studio.
    expect(defaultSeed("nyx")).toBe(hashString("nyx") % 0xffffffff);
    expect(defaultSeed("nyx")).toBe(defaultSeed("nyx"));
    expect(defaultSeed("nyx")).not.toBe(defaultSeed("elara"));
  });
});

describe("Rng", () => {
  it("produces an identical stream for the same seed", () => {
    const a = new Rng(123);
    const b = new Rng(123);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });

  it("forks into independent but deterministic streams", () => {
    expect(new Rng("x").fork("bass").next()).toBe(new Rng("x").fork("bass").next());
    expect(new Rng("x").fork("bass").next()).not.toBe(new Rng("x").fork("lead").next());
  });

  it("seed and string seed both yield values in [0,1)", () => {
    for (const seed of [0, 1, 999, "label"] as const) {
      const v = new Rng(seed).next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
