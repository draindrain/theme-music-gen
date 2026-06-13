import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ParamValidationError, parseCharacterParams, parseLocationParams, parseParams,
} from "../src/schema/params.ts";
import { characterPrompt, locationPrompt } from "../src/schema/prompt.ts";
import { parseDescription } from "../src/schema/params.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function loadJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("parameter schema", () => {
  it("accepts every shipped character fixture", () => {
    for (const f of readdirSync(join(FIXTURES, "characters")).filter((f) => f.endsWith(".params.json"))) {
      const p = parseCharacterParams(loadJson(join(FIXTURES, "characters", f)), f);
      expect(p.kind).toBe("character");
    }
  });

  it("accepts every shipped location fixture", () => {
    for (const f of readdirSync(join(FIXTURES, "locations")).filter((f) => f.endsWith(".params.json"))) {
      const p = parseLocationParams(loadJson(join(FIXTURES, "locations", f)), f);
      expect(p.kind).toBe("location");
    }
  });

  it("rejects out-of-enum values with a typed error, never a silent pass", () => {
    const good = loadJson(join(FIXTURES, "characters", "elara.params.json")) as Record<string, unknown>;
    const bad = { ...good, baseTempo: "extremely_fast" };
    expect(() => parseParams(bad, "test")).toThrowError(ParamValidationError);
    try {
      parseParams(bad, "test");
    } catch (e) {
      const err = e as ParamValidationError;
      expect(err.issues.some((i) => i.path === "baseTempo")).toBe(true);
    }
  });

  it("rejects unknown extra fields (strict schemas)", () => {
    const good = loadJson(join(FIXTURES, "characters", "elara.params.json")) as Record<string, unknown>;
    expect(() => parseParams({ ...good, swagger: 11 }, "test")).toThrowError(ParamValidationError);
  });

  it("rejects out-of-enum instrument inside the palette", () => {
    const good = loadJson(join(FIXTURES, "characters", "elara.params.json")) as { palette: object };
    const bad = { ...good, palette: { ...good.palette, lead: "theremin" } };
    expect(() => parseParams(bad, "test")).toThrowError(ParamValidationError);
  });

  it("prompt templates embed the description and the full enum space", () => {
    const desc = parseDescription(loadJson(join(FIXTURES, "characters", "elara.json")));
    const prompt = characterPrompt(desc, 42);
    expect(prompt).toContain(desc.description);
    expect(prompt).toContain('"harmonic_minor"');
    expect(prompt).toContain('"music_box"');
    expect(prompt).toContain('"seed": 42');

    const ldesc = parseDescription(loadJson(join(FIXTURES, "locations", "cafe.json")));
    const lprompt = locationPrompt(ldesc, 7);
    expect(lprompt).toContain(ldesc.description);
    expect(lprompt).toContain('"crowd_murmur"');
  });
});
