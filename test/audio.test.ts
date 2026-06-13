import { describe, expect, it } from "vitest";
import { createBuf, bufLength } from "../src/audio/buffer.ts";
import { decodeWav, encodeWavPcm16 } from "../src/audio/wav.ts";
import {
  crossfadeLoop, normalizeLoudness, peakDb, rmsDb, wrapTailIntoLoop, TARGET_RMS_DB,
} from "../src/post/post.ts";
import { loopSeamReport } from "../src/analysis/analyze.ts";

function sine(sr: number, n: number, freq: number, amp = 0.5): ReturnType<typeof createBuf> {
  const buf = createBuf(sr, n);
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < n; i++) buf.channels[c]![i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return buf;
}

describe("wav round trip", () => {
  it("pcm16 encode/decode preserves audio within quantization error", () => {
    const buf = sine(44100, 4410, 440);
    const back = decodeWav(encodeWavPcm16(buf));
    expect(back.sampleRate).toBe(44100);
    expect(bufLength(back)).toBe(4410);
    let maxErr = 0;
    for (let i = 0; i < 4410; i++)
      maxErr = Math.max(maxErr, Math.abs(back.channels[0]![i]! - buf.channels[0]![i]!));
    expect(maxErr).toBeLessThan(2 / 32768 + 1e-6);
  });
});

describe("loop post-processing", () => {
  it("wrapTailIntoLoop folds tail energy back onto the start", () => {
    const sr = 44100;
    const buf = createBuf(sr, sr); // 1s total, loop = 0.75s
    const loopN = Math.floor(sr * 0.75);
    buf.channels[0]![loopN + 100] = 0.8; // an impulse in the tail
    const out = wrapTailIntoLoop(buf, loopN);
    expect(bufLength(out)).toBe(loopN);
    expect(out.channels[0]![100]).toBeCloseTo(0.8, 6);
  });

  it("crossfadeLoop output loops without a seam (sine torture test)", () => {
    const sr = 44100;
    // a sine whose period does NOT divide the length: raw loop would click
    const buf = sine(sr, sr * 4, 331.7, 0.5);
    const looped = crossfadeLoop(buf, 1.0);
    const report = loopSeamReport(looped);
    expect(report.pass).toBe(true);
  });

  it("the seam detector CATCHES a genuinely bad loop (negative control)", () => {
    const sr = 44100;
    const buf = sine(sr, Math.floor(sr * 2.013), 331.7, 0.5); // ends mid-phase
    const report = loopSeamReport(buf);
    expect(report.pass).toBe(false);
  });

  it("normalizes to the target RMS with peaks under the ceiling", () => {
    const quiet = sine(44100, 44100, 220, 0.01);
    const out = normalizeLoudness(quiet);
    expect(rmsDb(out)).toBeCloseTo(TARGET_RMS_DB, 1);
    expect(peakDb(out)).toBeLessThanOrEqual(-0.99);

    // pathological crest factor: limiter must hold the ceiling
    const spiky = sine(44100, 44100, 220, 0.001);
    spiky.channels[0]![500] = 0.9;
    spiky.channels[1]![500] = 0.9;
    const limited = normalizeLoudness(spiky);
    expect(peakDb(limited)).toBeLessThanOrEqual(-0.9);
  });
});
