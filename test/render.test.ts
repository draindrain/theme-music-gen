/**
 * End-to-end render verification: every claim about the audio is checked by
 * the analysis harness, per backend.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderAmbience, ambienceLoopSamples, AMBIENCE_LOOP_SEC } from "../src/ambience/ambience.ts";
import {
  detectTempoBpm, inKeyEnergyRatio, isEffectivelySilent, loopSeamReport, tempoMatches,
} from "../src/analysis/analyze.ts";
import { bufLength } from "../src/audio/buffer.ts";
import { composeScore } from "../src/compose/arrange.ts";
import { crossfadeLoop, normalizeLoudness, rmsDb, wrapTailIntoLoop, TARGET_RMS_DB } from "../src/post/post.ts";
import {
  parseCharacterParams, parseLocationParams, type CharacterParams, type LocationParams,
} from "../src/schema/params.ts";
import { loopSeconds } from "../src/score/types.ts";
import { derivePrompt, apiBackend } from "../src/synth/api/backend.ts";
import { mockProvider } from "../src/synth/api/mockProvider.ts";
import { dspBackend } from "../src/synth/dsp/backend.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const SR = 44100;

function character(id: string): CharacterParams {
  return parseCharacterParams(
    JSON.parse(readFileSync(join(FIXTURES, "characters", `${id}.params.json`), "utf8")), id);
}
function location(id: string): LocationParams {
  return parseLocationParams(
    JSON.parse(readFileSync(join(FIXTURES, "locations", `${id}.params.json`), "utf8")), id);
}

describe("dsp backend", () => {
  // one light arrangement, one dense one with percussion
  for (const [id, mood] of [["elara", "sad"], ["nyx", "happy"]] as const) {
    it(`renders ${id}/${mood}: duration, loudness, key, tempo, seam all verified`, async () => {
      const params = character(id);
      const score = composeScore(params, mood);
      const { audio, loop } = await dspBackend.render(score, { sampleRate: SR });
      expect(loop.kind).toBe("wrap");
      const loopSamples = loop.kind === "wrap" ? loop.loopSamples : 0;
      const final = normalizeLoudness(wrapTailIntoLoop(audio, loopSamples));

      expect(bufLength(final)).toBe(Math.round(loopSeconds(score) * SR));
      expect(isEffectivelySilent(final)).toBe(false);
      expect(Math.abs(rmsDb(final) - TARGET_RMS_DB)).toBeLessThan(0.75);
      expect(loopSeamReport(final).pass).toBe(true);
      expect(inKeyEnergyRatio(final, score.key)).toBeGreaterThan(0.8);
      expect(tempoMatches(detectTempoBpm(final), score.tempoBpm)).toBe(true);
    });
  }
});

describe("ambience engine", () => {
  for (const id of ["rainy-street", "cafe", "night-forest"]) {
    it(`renders ${id}: non-silent, target loudness, seamless loop`, () => {
      const raw = renderAmbience(location(id), SR);
      const final = normalizeLoudness(wrapTailIntoLoop(raw, ambienceLoopSamples(SR)));
      expect(bufLength(final)).toBe(AMBIENCE_LOOP_SEC * SR);
      expect(isEffectivelySilent(final)).toBe(false);
      expect(Math.abs(rmsDb(final) - TARGET_RMS_DB)).toBeLessThan(0.75);
      expect(loopSeamReport(final).pass).toBe(true);
    });
  }

  it("is deterministic for a fixed seed", () => {
    const a = renderAmbience(location("cafe"), 22050);
    const b = renderAmbience(location("cafe"), 22050);
    expect(Buffer.from(a.channels[0].buffer).equals(Buffer.from(b.channels[0].buffer))).toBe(true);
  });
});

describe("api backend (mock provider — no vendor, no key, no network)", () => {
  it("derives a faithful text prompt from the score parameters", () => {
    const score = composeScore(character("bram"), "melancholy");
    const prompt = derivePrompt(score);
    expect(prompt).toContain("wistful");
    expect(prompt).toContain(`${score.tempoBpm} BPM`);
    expect(prompt).toContain(`Key of ${score.key.tonic}`);
    expect(prompt).toContain('"bram"');
    expect(prompt).toContain("cello");
    expect(prompt).toContain("loopable");
  });

  it("runs the full pipeline against the mock and meets the same output contract", async () => {
    const score = composeScore(character("elara"), "happy");
    const { audio, loop } = await apiBackend.render(score, { sampleRate: SR });
    expect(loop.kind).toBe("crossfade");
    const fadeSec = loop.kind === "crossfade" ? loop.fadeSec : 0;
    const final = normalizeLoudness(crossfadeLoop(audio, fadeSec));
    expect(isEffectivelySilent(final)).toBe(false);
    expect(Math.abs(rmsDb(final) - TARGET_RMS_DB)).toBeLessThan(0.75);
    expect(loopSeamReport(final).pass).toBe(true);
  });

  it("mock provider is deterministic in prompt+seed", async () => {
    const req = { prompt: "x", durationSec: 2, sampleRate: 22050, seed: 7 };
    const a = await mockProvider.generate(req);
    const b = await mockProvider.generate(req);
    expect(Buffer.from(a.channels[0].buffer).equals(Buffer.from(b.channels[0].buffer))).toBe(true);
  });
});
