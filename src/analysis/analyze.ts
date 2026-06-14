/**
 * Audio analysis harness: everything the test suite (and `analyze` CLI) uses
 * to verify rendered output instead of trusting the renderer.
 */
import { bufLength, type AudioBuf } from "../audio/buffer.ts";
import { scalePitchClasses, type Key } from "../theory/theory.ts";

// ---------- FFT (radix-2, in-place) ----------

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error("fft size must be a power of 2");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1,
        cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!,
          ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cwr - im[i + k + len / 2]! * cwi;
        const vi = re[i + k + len / 2]! * cwi + im[i + k + len / 2]! * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

function toMono(buf: AudioBuf): Float32Array {
  const n = bufLength(buf);
  const m = new Float32Array(n);
  const [l, r] = buf.channels;
  for (let i = 0; i < n; i++) m[i] = (l[i]! + r[i]!) / 2;
  return m;
}

// ---------- chroma / key check ----------

/**
 * Pitch-class energy profile via windowed FFTs. Returns 12 energies summing
 * to 1 (C=0 ... B=11).
 */
export function chromaProfile(buf: AudioBuf, frameSize = 8192): Float64Array {
  const mono = toMono(buf);
  const sr = buf.sampleRate;
  const chroma = new Float64Array(12);
  const hop = frameSize * 2; // sparse sampling is fine for a whole track
  for (let start = 0; start + frameSize <= mono.length; start += hop) {
    const re = new Float64Array(frameSize);
    const im = new Float64Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frameSize); // Hann
      re[i] = mono[start + i]! * w;
    }
    fft(re, im);
    for (let k = 1; k < frameSize / 2; k++) {
      const freq = (k * sr) / frameSize;
      if (freq < 60 || freq > 4000) continue;
      const mag2 = re[k]! * re[k]! + im[k]! * im[k]!;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      // skip bins that fall between semitones (reduces leakage noise)
      if (Math.abs(midi - Math.round(midi)) > 0.35) continue;
      chroma[pc]! += mag2;
    }
  }
  const total = chroma.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < 12; i++) chroma[i]! /= total;
  return chroma;
}

/** Fraction of chroma energy on the declared key's scale pitch classes. */
export function inKeyEnergyRatio(buf: AudioBuf, key: Key): number {
  const chroma = chromaProfile(buf);
  const scale = scalePitchClasses(key);
  let inKey = 0;
  for (let pc = 0; pc < 12; pc++) if (scale.has(pc)) inKey += chroma[pc]!;
  return inKey;
}

// ---------- tempo ----------

export interface TempoEstimate {
  bpm: number;
  /**
   * 0..1 contrast of the beat spectrum. Sustained/legato material can have an
   * essentially flat beat spectrum — tempo is then underdetermined in the
   * signal and the estimate is noise; callers should gate on this.
   */
  confidence: number;
}

/** Estimate tempo (BPM in [50,200)) from a spectral-flux onset envelope. */
export function detectTempoBpm(buf: AudioBuf): number {
  return detectTempo(buf).bpm;
}

export function detectTempo(buf: AudioBuf): TempoEstimate {
  const mono = toMono(buf);
  const sr = buf.sampleRate;
  // spectral-flux onset envelope: robust for soft/legato attacks where pure
  // amplitude envelopes carry no beat information
  const frame = 2048;
  const hop = 512;
  const nFrames = Math.floor((mono.length - frame) / hop);
  const nBins = frame / 2;
  const prevMag = new Float64Array(nBins);
  const onset = new Float64Array(nFrames);
  const hann = new Float64Array(frame);
  for (let i = 0; i < frame; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  for (let f = 0; f < nFrames; f++) {
    const re = new Float64Array(frame);
    const im = new Float64Array(frame);
    for (let i = 0; i < frame; i++) re[i] = mono[f * hop + i]! * hann[i]!;
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < nBins; k++) {
      const mag = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
      const d = mag - prevMag[k]!;
      if (d > 0) flux += d;
      prevMag[k] = mag;
    }
    onset[f] = flux;
  }
  // remove the slow-moving mean so sustained crescendos don't smear the ACF
  const meanWin = Math.round((sr / hop) * 0.5);
  const smoothed = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0,
      c = 0;
    for (let g = Math.max(0, f - meanWin); g < Math.min(nFrames, f + meanWin); g++) {
      s += onset[g]!;
      c++;
    }
    smoothed[f] = Math.max(0, onset[f]! - s / c);
  }
  smoothed.forEach((v, i) => (onset[i] = v));
  const frameRate = sr / hop;
  // raw autocorrelation of the onset envelope
  const maxAcfLag = Math.min(nFrames - 1, Math.ceil((60 / 50) * frameRate) * 3 + 2);
  const acf = new Float64Array(maxAcfLag + 1);
  for (let lag = 1; lag <= maxAcfLag; lag++) {
    let s = 0;
    for (let f = 0; f + lag < nFrames; f++) s += onset[f]! * onset[f + lag]!;
    acf[lag] = s / (nFrames - lag);
  }
  // comb scoring: the true beat period is supported by its own multiples,
  // off-grid subdivisions are not
  const minLag = Math.floor((60 / 200) * frameRate);
  const maxLag = Math.ceil((60 / 50) * frameRate);
  let bestLag = minLag,
    bestVal = -Infinity;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag && lag * 2 <= maxAcfLag; lag++) {
    let val = acf[lag]!;
    for (const [mult, w] of [
      [2, 0.6],
      [3, 0.4],
    ] as const) {
      const l = lag * mult;
      if (l <= maxAcfLag)
        val += w * Math.max(acf[l - 1]!, acf[l]!, acf[Math.min(l + 1, maxAcfLag)]!);
    }
    scores.push(val);
    if (val > bestVal) {
      bestVal = val;
      bestLag = lag;
    }
  }
  scores.sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)] ?? 0;
  const confidence = bestVal > 0 ? Math.max(0, 1 - median / bestVal) : 0;
  return { bpm: (60 * frameRate) / bestLag, confidence };
}

/**
 * True if detected tempo matches declared within tol, allowing metrical
 * levels: octaves, triplet levels and the dotted-quarter pulse (3/4).
 */
export function tempoMatches(detected: number, declared: number, tolRatio = 0.06): boolean {
  for (const mult of [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2, 3, 4]) {
    const target = declared * mult;
    if (Math.abs(detected - target) / target <= tolRatio) return true;
  }
  return false;
}

// ---------- loop seam ----------

export interface SeamReport {
  /** |x[0] - x[N-1]| worst channel, in full-scale units */
  boundaryJump: number;
  /** slope discontinuity at the junction, worst channel */
  slopeJump: number;
  /** 95th-percentile |x[i]-x[i-1]| in the 50ms adjacent to the seam */
  localDelta: number;
  /** boundaryJump / localDelta — the click-vs-context ratio */
  seamRatio: number;
  pass: boolean;
}

/**
 * Verify the file loops without a click. A click at the loop junction is a
 * value (or slope) discontinuity much larger than the sample-to-sample
 * movement of the material immediately around the seam; a legitimate note
 * attack on the downbeat is not (its oscillation is part of that context).
 */
export function loopSeamReport(buf: AudioBuf): SeamReport {
  const n = bufLength(buf);
  const winN = Math.min(Math.max(64, Math.floor(buf.sampleRate * 0.05)), Math.floor(n / 4)); // 50ms
  let boundaryJump = 0;
  let slopeJump = 0;
  let localDelta = 0;
  for (let c = 0; c < 2; c++) {
    const x = buf.channels[c]!;
    boundaryJump = Math.max(boundaryJump, Math.abs(x[0]! - x[n - 1]!));
    slopeJump = Math.max(slopeJump, Math.abs(x[1]! - x[0]! - (x[n - 1]! - x[n - 2]!)));
    // context: first differences in the windows touching the seam,
    // excluding the junction itself
    const deltas: number[] = [];
    for (let i = 1; i < winN; i++) deltas.push(Math.abs(x[i]! - x[i - 1]!));
    for (let i = n - winN + 1; i < n; i++) deltas.push(Math.abs(x[i]! - x[i - 1]!));
    deltas.sort((a, b) => a - b);
    localDelta = Math.max(localDelta, deltas[Math.floor(deltas.length * 0.95)] ?? 0);
  }
  const floor = 0.02; // -34 dBFS — steps this small are inaudible as clicks
  const limit = Math.max(3.5 * localDelta, floor);
  const seamRatio = boundaryJump / Math.max(localDelta, 1e-9);
  const pass = boundaryJump <= limit && slopeJump <= limit && boundaryJump < 0.15;
  return { boundaryJump, slopeJump, localDelta, seamRatio, pass };
}

// ---------- silence ----------

export function isEffectivelySilent(buf: AudioBuf, thresholdDb = -50): boolean {
  let sum = 0;
  const n = bufLength(buf);
  for (let c = 0; c < 2; c++) {
    const x = buf.channels[c]!;
    for (let i = 0; i < n; i++) sum += x[i]! * x[i]!;
  }
  const rms = Math.sqrt(sum / (2 * n));
  return 20 * Math.log10(Math.max(rms, 1e-12)) < thresholdDb;
}
