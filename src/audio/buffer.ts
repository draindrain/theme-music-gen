/** Stereo float audio in memory. All internal processing is float64-safe float32 arrays. */

export interface AudioBuf {
  sampleRate: number;
  /** [left, right] */
  channels: [Float32Array, Float32Array];
}

export function createBuf(sampleRate: number, lengthSamples: number): AudioBuf {
  return {
    sampleRate,
    channels: [new Float32Array(lengthSamples), new Float32Array(lengthSamples)],
  };
}

export function bufLength(buf: AudioBuf): number {
  return buf.channels[0].length;
}

export function bufSeconds(buf: AudioBuf): number {
  return bufLength(buf) / buf.sampleRate;
}

/** Mix `src` into `dst` starting at dstOffset, scaled by gain. */
export function mixInto(dst: AudioBuf, src: AudioBuf, dstOffset = 0, gain = 1): void {
  for (let c = 0; c < 2; c++) {
    const d = dst.channels[c]!;
    const s = src.channels[c]!;
    const n = Math.min(s.length, d.length - dstOffset);
    for (let i = 0; i < n; i++) d[dstOffset + i]! += s[i]! * gain;
  }
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
