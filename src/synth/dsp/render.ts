/**
 * Pure from-scratch synthesis: Score IR -> stereo float PCM.
 * No dependencies, fully deterministic (every stochastic element is seeded
 * from score id + track + note index). Renders loop body + tail; the shared
 * post-processing wraps the tail around for a seamless loop.
 */
import { createBuf, dbToGain, type AudioBuf } from "../../audio/buffer.ts";
import type { Note, Score, Track } from "../../score/types.ts";
import { loopSeconds } from "../../score/types.ts";
import { Rng, hashString } from "../../util/prng.ts";
import { PATCHES, type Patch } from "./instruments.ts";

export const RENDER_TAIL_SEC = 3;

export interface DspRenderOpts {
  sampleRate?: number;
}

const TWO_PI = Math.PI * 2;

/** Square-wave peak amplitude — pulled in from ±1 to tame the harsh fundamental. */
const SQUARE_AMPLITUDE = 0.7;
/** Keep the lowpass cutoff below this fraction of the sample rate (Nyquist guard). */
const NYQUIST_GUARD = 0.45;

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function oscSample(kind: string, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (kind) {
    case "sine":
      return Math.sin(TWO_PI * p);
    case "triangle":
      return 4 * Math.abs(p - 0.5) - 1;
    case "saw":
      return 2 * p - 1;
    case "square":
      return p < 0.5 ? SQUARE_AMPLITUDE : -SQUARE_AMPLITUDE;
    default:
      return Math.sin(TWO_PI * p);
  }
}

/**
 * Render one pitched note into a target mono Float32Array at sample offset.
 * Returns nothing; writes additively.
 */
function renderNoteInto(
  out: Float32Array,
  sampleRate: number,
  patch: Patch,
  note: Note,
  startSample: number,
  durSec: number,
  rng: Rng,
): void {
  const freq = midiToFreq(note.midi);
  const { a, d, s, r } = patch.adsr;
  const holdSec = Math.max(durSec, a + 0.02);
  const totalSec = holdSec + r;
  const n = Math.min(Math.floor(totalSec * sampleRate), out.length - startSample);
  if (n <= 0) return;
  const vel = note.velocity;
  const amp = patch.gain * (0.25 + 0.75 * vel * vel);

  if (patch.osc === "karplus") {
    renderKarplus(out, sampleRate, patch, freq, amp, startSample, n, holdSec, rng);
    return;
  }

  const unison = patch.unison ?? 1;
  const detune = (patch.detuneCents ?? 0) / 1200;
  const cutoffHz = Math.min(
    patch.cutoffMax ?? 9000,
    freq * patch.cutoffRatio,
    sampleRate * NYQUIST_GUARD,
  );
  // one-pole lowpass coefficient
  const lpC = Math.exp((-TWO_PI * cutoffHz) / sampleRate);
  const vib = patch.vibrato;
  const phases: number[] = [];
  const incs: number[] = [];
  for (let u = 0; u < unison; u++) {
    const spread = unison > 1 ? (u / (unison - 1)) * 2 - 1 : 0;
    phases.push(rng.next()); // free-running start phase per voice (deterministic)
    incs.push((freq * Math.pow(2, spread * detune)) / sampleRate);
  }
  // FM modulator state
  const fmRatio = patch.fmRatio ?? 1;
  const fmIndex0 = patch.fmIndex ?? 0;
  const fmDecay = patch.fmIndexDecay ?? 0.3;
  let modPhase = 0;

  let lp = 0;
  let env: number;
  const aN = Math.max(1, a * sampleRate);
  const dN = Math.max(1, d * sampleRate);
  const rN = Math.max(1, r * sampleRate);
  const holdN = Math.floor(holdSec * sampleRate);
  const breath = patch.breath ?? 0;

  for (let i = 0; i < n; i++) {
    // envelope
    if (i < aN) env = i / aN;
    else if (i < holdN) {
      const t = (i - aN) / dN;
      env = t >= 1 ? s : 1 + (s - 1) * t;
    } else {
      const t = (i - holdN) / rN;
      env = Math.max(0, (s || envAtHold(a, d, s, holdN, aN, dN)) * (1 - t));
    }
    if (env <= 0 && i > holdN) break;

    const tSec = i / sampleRate;
    let vibMul = 1;
    if (vib && tSec > vib.delaySec) {
      const depth = vib.depthCents / 1200;
      vibMul = Math.pow(2, depth * Math.sin(TWO_PI * vib.rateHz * (tSec - vib.delaySec)));
    }

    let sample = 0;
    if (patch.osc === "fm") {
      const idx = fmIndex0 * Math.exp(-tSec / fmDecay);
      modPhase += (freq * fmRatio * vibMul) / sampleRate;
      phases[0]! += (freq * vibMul) / sampleRate;
      sample = Math.sin(TWO_PI * phases[0]! + idx * Math.sin(TWO_PI * modPhase));
    } else {
      for (let u = 0; u < unison; u++) {
        phases[u]! += incs[u]! * vibMul;
        sample += oscSample(patch.osc, phases[u]!);
      }
      sample /= unison;
    }
    if (breath > 0) sample += (rng.next() * 2 - 1) * breath;

    // one-pole lowpass
    lp = sample * (1 - lpC) + lp * lpC;
    out[startSample + i]! += lp * env * amp;
  }
}

function envAtHold(a: number, d: number, s: number, holdN: number, aN: number, dN: number): number {
  if (holdN < aN) return holdN / aN;
  const t = (holdN - aN) / dN;
  return t >= 1 ? s : 1 + (s - 1) * t;
}

/** Karplus-Strong plucked string. */
function renderKarplus(
  out: Float32Array,
  sampleRate: number,
  patch: Patch,
  freq: number,
  amp: number,
  startSample: number,
  n: number,
  holdSec: number,
  rng: Rng,
): void {
  const period = Math.max(2, Math.round(sampleRate / freq));
  const line = new Float32Array(period);
  for (let i = 0; i < period; i++) line[i] = rng.next() * 2 - 1;
  // pre-filter the excitation for a softer attack
  for (let i = 1; i < period; i++) line[i] = (line[i]! + line[i - 1]!) * 0.5;
  const damp = patch.kpDamp ?? 0.4;
  const blend = 0.5 + 0.5 * (1 - damp);
  let idx = 0;
  const fadeN = Math.floor(0.01 * sampleRate);
  const relStart = Math.floor(holdSec * sampleRate);
  const relN = Math.max(1, Math.floor(patch.adsr.r * sampleRate));
  for (let i = 0; i < n; i++) {
    const cur = line[idx]!;
    const next = line[(idx + 1) % period]!;
    line[idx] = (cur * blend + next * (1 - blend)) * 0.996;
    idx = (idx + 1) % period;
    let g = 1;
    if (i < fadeN) g = i / fadeN; // zero-start so loop seams stay clean
    if (i > relStart) g *= Math.max(0, 1 - (i - relStart) / relN);
    out[startSample + i]! += cur * amp * g;
    if (i > relStart && g <= 0) break;
  }
}

/** GM-drum-key percussion, synthesized. */
function renderPercInto(
  out: Float32Array,
  sampleRate: number,
  note: Note,
  startSample: number,
  rng: Rng,
): void {
  const vel = note.velocity;
  switch (note.midi) {
    case 36: {
      // kick: sine sweep 110 -> 45 Hz
      const n = Math.min(Math.floor(0.16 * sampleRate), out.length - startSample);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const f = 45 + 65 * Math.exp(-t * 30);
        phase += f / sampleRate;
        const env = Math.min(1, i / (0.002 * sampleRate)) * Math.exp(-t * 22);
        out[startSample + i]! += Math.sin(TWO_PI * phase) * env * vel * 0.9;
      }
      break;
    }
    case 37: {
      // rim: short band-noise tick
      const n = Math.min(Math.floor(0.04 * sampleRate), out.length - startSample);
      let bp = 0,
        bp2 = 0;
      const f = (TWO_PI * 1800) / sampleRate;
      for (let i = 0; i < n; i++) {
        const x = rng.next() * 2 - 1;
        bp += f * (x - bp - bp2 * 0.6);
        bp2 += f * bp;
        const env = Math.min(1, i / (0.001 * sampleRate)) * Math.exp((-i / sampleRate) * 90);
        out[startSample + i]! += bp * env * vel * 0.8;
      }
      break;
    }
    case 42: {
      // closed hat: highpassed noise
      const n = Math.min(Math.floor(0.06 * sampleRate), out.length - startSample);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const x = rng.next() * 2 - 1;
        lp = lp * 0.6 + x * 0.4;
        const hp = x - lp;
        const env = Math.min(1, i / (0.001 * sampleRate)) * Math.exp((-i / sampleRate) * 60);
        out[startSample + i]! += hp * env * vel * 0.5;
      }
      break;
    }
    default: {
      // 70 shaker (and anything else): soft band noise
      const n = Math.min(Math.floor(0.09 * sampleRate), out.length - startSample);
      let lp = 0,
        lp2 = 0;
      for (let i = 0; i < n; i++) {
        const x = rng.next() * 2 - 1;
        lp = lp * 0.55 + x * 0.45;
        lp2 = lp2 * 0.55 + lp * 0.45;
        const band = lp - lp2;
        const t = i / sampleRate;
        const env = Math.min(1, t / 0.012) * Math.exp(-t * 45);
        out[startSample + i]! += band * env * vel * 0.6;
      }
    }
  }
}

/** Simple deterministic Schroeder reverb (4 combs + 2 allpass), stereo. */
export function schroederReverb(input: AudioBuf, wet: number, decay = 0.78): AudioBuf {
  const sr = input.sampleRate;
  const n = input.channels[0].length;
  const out = createBuf(sr, n);
  const combDelaysL = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => Math.floor(s * sr));
  const combDelaysR = [0.0313, 0.0353, 0.0421, 0.0457].map((s) => Math.floor(s * sr));
  for (let c = 0; c < 2; c++) {
    const x = input.channels[c]!;
    const y = out.channels[c]!;
    const delays = c === 0 ? combDelaysL : combDelaysR;
    const combSum = new Float32Array(n);
    for (const dl of delays) {
      const buf = new Float32Array(dl);
      let idx = 0;
      let damp = 0;
      for (let i = 0; i < n; i++) {
        const delayed = buf[idx]!;
        damp = damp * 0.35 + delayed * 0.65;
        buf[idx] = x[i]! + damp * decay;
        combSum[i]! += delayed;
        idx = (idx + 1) % dl;
      }
    }
    // two series allpasses
    let signal = combSum;
    for (const apSec of [0.005, 0.0017]) {
      const dl = Math.floor(apSec * sr);
      const buf = new Float32Array(dl);
      let idx = 0;
      const next = new Float32Array(n);
      const g = 0.7;
      for (let i = 0; i < n; i++) {
        const delayed = buf[idx]!;
        const inp = signal[i]!;
        const v = inp + delayed * g;
        next[i] = delayed - v * g;
        buf[idx] = v;
        idx = (idx + 1) % dl;
      }
      signal = next;
    }
    for (let i = 0; i < n; i++) y[i] = signal[i]! * wet * 0.25;
  }
  return out;
}

export function renderScoreDsp(score: Score, opts: DspRenderOpts = {}): AudioBuf {
  const sr = opts.sampleRate ?? 44100;
  const loopSec = loopSeconds(score);
  const total = Math.round((loopSec + RENDER_TAIL_SEC) * sr);
  const secPerBeat = 60 / score.tempoBpm;

  const dry = createBuf(sr, total);
  const revIn = createBuf(sr, total);

  for (const track of score.tracks) {
    const mono = new Float32Array(total);
    const trackSeed = hashString(`${score.id}/${track.name}`) ^ score.meta.seed;
    renderTrackMono(mono, sr, track, secPerBeat, trackSeed);

    const gain = dbToGain(track.gainDb);
    const panL = Math.cos(((track.pan + 1) / 4) * Math.PI);
    const panR = Math.sin(((track.pan + 1) / 4) * Math.PI);
    const send = track.isPercussion ? 0.06 : PATCHES[track.instrument].reverbSend;
    const dl = dry.channels[0],
      dr = dry.channels[1];
    const rl = revIn.channels[0],
      rr = revIn.channels[1];
    for (let i = 0; i < total; i++) {
      const v = mono[i]! * gain;
      dl[i]! += v * panL;
      dr[i]! += v * panR;
      rl[i]! += v * panL * send;
      rr[i]! += v * panR * send;
    }
  }

  const wet = schroederReverb(revIn, 1.0);
  const out = createBuf(sr, total);
  for (let c = 0; c < 2; c++) {
    const o = out.channels[c]!,
      d = dry.channels[c]!,
      w = wet.channels[c]!;
    for (let i = 0; i < total; i++) o[i] = d[i]! + w[i]!;
  }
  return out;
}

function renderTrackMono(
  mono: Float32Array,
  sr: number,
  track: Track,
  secPerBeat: number,
  trackSeed: number,
): void {
  const patch = track.isPercussion ? null : PATCHES[track.instrument];
  for (let ni = 0; ni < track.notes.length; ni++) {
    const note = track.notes[ni]!;
    const rng = new Rng(trackSeed).fork(`n${ni}`);
    const startSample = Math.round(note.startBeat * secPerBeat * sr);
    if (startSample >= mono.length) continue;
    if (track.isPercussion) {
      renderPercInto(mono, sr, note, startSample, rng);
    } else {
      renderNoteInto(mono, sr, patch!, note, startSample, note.durBeats * secPerBeat, rng);
    }
  }
}
