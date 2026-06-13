/**
 * Soundfont backend tests — run only when fluidsynth + the soundfont are
 * present (`pnpm run setup`). CI/dev without them still gets full coverage of
 * everything else; these verify the default backend meets the same contract.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectTempoBpm, inKeyEnergyRatio, isEffectivelySilent, loopSeamReport, tempoMatches,
} from "../src/analysis/analyze.ts";
import { bufLength } from "../src/audio/buffer.ts";
import { composeScore } from "../src/compose/arrange.ts";
import { normalizeLoudness, rmsDb, wrapTailIntoLoop, TARGET_RMS_DB } from "../src/post/post.ts";
import { parseCharacterParams } from "../src/schema/params.ts";
import { loopSeconds } from "../src/score/types.ts";
import { scoreToMidi } from "../src/score/midi.ts";
import { soundfontBackend } from "../src/synth/soundfont.ts";

const available = soundfontBackend.availability().ok;
const SR = 44100;

describe.skipIf(!available)("soundfont backend (fluidsynth)", () => {
  it("meets the output contract: duration, loudness, key, tempo, seam", async () => {
    const params = parseCharacterParams(
      JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "characters", "nyx.params.json"), "utf8")));
    const score = composeScore(params, "tense");
    const { audio, loop } = await soundfontBackend.render(score, { sampleRate: SR });
    const loopSamples = loop.kind === "wrap" ? loop.loopSamples : 0;
    const final = normalizeLoudness(wrapTailIntoLoop(audio, loopSamples));

    expect(bufLength(final)).toBe(Math.round(loopSeconds(score) * SR));
    expect(isEffectivelySilent(final)).toBe(false);
    expect(Math.abs(rmsDb(final) - TARGET_RMS_DB)).toBeLessThan(0.75);
    expect(loopSeamReport(final).pass).toBe(true);
    expect(inKeyEnergyRatio(final, score.key)).toBeGreaterThan(0.7);
    expect(tempoMatches(detectTempoBpm(final), score.tempoBpm)).toBe(true);
  });
});

describe("midi export", () => {
  it("writes a structurally valid format-1 SMF", () => {
    const params = parseCharacterParams(
      JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "characters", "elara.params.json"), "utf8")));
    const score = composeScore(params, "playful");
    const midi = scoreToMidi(score);
    expect(midi.toString("ascii", 0, 4)).toBe("MThd");
    expect(midi.readUInt16BE(8)).toBe(1); // format 1
    expect(midi.readUInt16BE(10)).toBe(score.tracks.length + 1);
    // count MTrk chunks by walking the chunk structure
    let pos = 14, tracks = 0;
    while (pos + 8 <= midi.length) {
      expect(midi.toString("ascii", pos, pos + 4)).toBe("MTrk");
      tracks++;
      pos += 8 + midi.readUInt32BE(pos + 4);
    }
    expect(pos).toBe(midi.length);
    expect(tracks).toBe(score.tracks.length + 1);
  });
});
