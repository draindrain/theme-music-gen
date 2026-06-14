/**
 * Shared post-processing for every backend: make the track loop seamlessly,
 * normalize loudness to a consistent target, write WAV (+ OGG via ffmpeg).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { bufLength, createBuf, type AudioBuf } from "../audio/buffer.ts";
import { encodeWavPcm16 } from "../audio/wav.ts";

export const TARGET_RMS_DB = -16;
export const PEAK_CEILING_DB = -1;

/**
 * Seamless loop via tail wrap: input is loopSamples + tail; everything past
 * the loop point (note releases, reverb tail) is mixed back onto the start.
 * Because every voice attacks from zero amplitude, sample 0 of the body is
 * ~0 and the wrapped junction is continuous.
 */
export function wrapTailIntoLoop(buf: AudioBuf, loopSamples: number): AudioBuf {
  const n = bufLength(buf);
  if (loopSamples >= n) return buf;
  const out = createBuf(buf.sampleRate, loopSamples);
  for (let c = 0; c < 2; c++) {
    const src = buf.channels[c]!;
    const dst = out.channels[c]!;
    dst.set(src.subarray(0, loopSamples));
    const tail = n - loopSamples;
    for (let i = 0; i < tail; i++) dst[i % loopSamples]! += src[loopSamples + i]!;
  }
  return out;
}

/**
 * Seamless loop via equal-power crossfade (for material without a separable
 * tail, e.g. the api backend): the first `fadeSec` is blended onto the end,
 * and the output starts at the fade midpoint... simpler: output is
 * input minus the fade region, with end crossfaded into start.
 */
export function crossfadeLoop(buf: AudioBuf, fadeSec: number): AudioBuf {
  const sr = buf.sampleRate;
  const fadeN = Math.min(Math.floor(fadeSec * sr), Math.floor(bufLength(buf) / 4));
  const outN = bufLength(buf) - fadeN;
  const out = createBuf(sr, outN);
  for (let c = 0; c < 2; c++) {
    const src = buf.channels[c]!;
    const dst = out.channels[c]!;
    dst.set(src.subarray(0, outN));
    // blend the discarded tail into the head with equal-power gains
    for (let i = 0; i < fadeN; i++) {
      const t = i / fadeN;
      const gHead = Math.sin((t * Math.PI) / 2);
      const gTail = Math.cos((t * Math.PI) / 2);
      dst[i] = src[i]! * gHead + src[outN + i]! * gTail;
    }
  }
  return out;
}

export function rmsDb(buf: AudioBuf): number {
  let sum = 0;
  const n = bufLength(buf);
  for (let c = 0; c < 2; c++) {
    const x = buf.channels[c]!;
    for (let i = 0; i < n; i++) sum += x[i]! * x[i]!;
  }
  const rms = Math.sqrt(sum / (n * 2));
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

export function peakDb(buf: AudioBuf): number {
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const x = buf.channels[c]!;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  }
  return 20 * Math.log10(Math.max(peak, 1e-9));
}

/**
 * Scale to target RMS; if that would push peaks above the ceiling, apply a
 * soft knee (tanh) limiter sized so the ceiling holds. Deterministic.
 */
export function normalizeLoudness(buf: AudioBuf, targetDb = TARGET_RMS_DB): AudioBuf {
  const gain = Math.pow(10, (targetDb - rmsDb(buf)) / 20);
  const ceiling = Math.pow(10, PEAK_CEILING_DB / 20);
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const x = buf.channels[c]!;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]! * gain));
  }
  const out = createBuf(buf.sampleRate, bufLength(buf));
  if (peak <= ceiling) {
    for (let c = 0; c < 2; c++) {
      const x = buf.channels[c]!, y = out.channels[c]!;
      for (let i = 0; i < x.length; i++) y[i] = x[i]! * gain;
    }
    return out;
  }
  // soft limiter: linear below the knee, tanh above, asymptote at the ceiling
  const knee = ceiling * 0.6;
  const range = ceiling - knee;
  for (let c = 0; c < 2; c++) {
    const x = buf.channels[c]!, y = out.channels[c]!;
    for (let i = 0; i < x.length; i++) {
      const v = x[i]! * gain;
      const a = Math.abs(v);
      y[i] = a <= knee ? v : Math.sign(v) * (knee + range * Math.tanh((a - knee) / range));
    }
  }
  return out;
}

export class MissingToolError extends Error {
  constructor(tool: string, hint: string) {
    super(`Required tool "${tool}" was not found on PATH. ${hint}`);
    this.name = "MissingToolError";
  }
}

export function haveBinary(name: string): boolean {
  for (const flag of ["-version", "--version"]) {
    try {
      execFileSync(name, [flag], { stdio: "ignore" });
      return true;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") return false;
      // Binary exists but exited non-zero — that's fine, it ran.
      return true;
    }
  }
  return false;
}

export function writeWav(buf: AudioBuf, path: string): void {
  writeFileSync(path, encodeWavPcm16(buf));
}

export function encodeOgg(wavPath: string, oggPath: string): void {
  if (!haveBinary("ffmpeg"))
    throw new MissingToolError("ffmpeg", "Install it (e.g. `apt install ffmpeg` / `brew install ffmpeg` / `winget install Gyan.FFmpeg`) to get OGG output.");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wavPath, "-c:a", "libvorbis", "-q:a", "5", oggPath], { stdio: "inherit" });
}

export interface FinalizeResult {
  wavPath: string;
  /** Present only when OGG encoding was requested (the default). */
  oggPath?: string;
  rmsDb: number;
  peakDb: number;
  seconds: number;
}

/**
 * Loop-wrap (if loopSamples given), normalize, write WAV (always) and OGG
 * (unless `ogg: false`). WAV is the canonical playback/analysis format, so it
 * is always emitted; OGG is opt-out for back-compat and skippable when ffmpeg
 * is absent or the caller doesn't want it.
 */
export function finalizeLoop(
  raw: AudioBuf,
  outBase: string,
  opts: { loopSamples?: number; crossfadeSec?: number; ogg?: boolean },
): FinalizeResult {
  let buf = raw;
  if (opts.loopSamples !== undefined) buf = wrapTailIntoLoop(buf, opts.loopSamples);
  else if (opts.crossfadeSec !== undefined) buf = crossfadeLoop(buf, opts.crossfadeSec);
  buf = normalizeLoudness(buf);
  const wavPath = `${outBase}.wav`;
  writeWav(buf, wavPath);
  const base = { wavPath, rmsDb: rmsDb(buf), peakDb: peakDb(buf), seconds: bufLength(buf) / buf.sampleRate };
  if (opts.ogg === false) return base;
  const oggPath = `${outBase}.ogg`;
  encodeOgg(wavPath, oggPath);
  return { ...base, oggPath };
}
