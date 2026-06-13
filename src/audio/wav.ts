/** Minimal RIFF/WAVE writer + reader (PCM16 and float32), no dependencies. */
import { createBuf, type AudioBuf } from "./buffer.ts";

export function encodeWavPcm16(buf: AudioBuf): Buffer {
  const n = buf.channels[0].length;
  const numCh = 2;
  const byteRate = buf.sampleRate * numCh * 2;
  const dataSize = n * numCh * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(numCh, 22);
  out.writeUInt32LE(buf.sampleRate, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(numCh * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  let o = 44;
  const [l, r] = buf.channels;
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(floatToInt16(l[i]!), o); o += 2;
    out.writeInt16LE(floatToInt16(r[i]!), o); o += 2;
  }
  return out;
}

function floatToInt16(x: number): number {
  const v = Math.max(-1, Math.min(1, x));
  return Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
}

export function decodeWav(data: Buffer): AudioBuf {
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a RIFF/WAVE file");
  let pos = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataChunk: { offset: number; size: number } | null = null;
  while (pos + 8 <= data.length) {
    const id = data.toString("ascii", pos, pos + 4);
    const size = data.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmt = {
        format: data.readUInt16LE(pos + 8),
        channels: data.readUInt16LE(pos + 10),
        sampleRate: data.readUInt32LE(pos + 12),
        bits: data.readUInt16LE(pos + 22),
      };
    } else if (id === "data") {
      dataChunk = { offset: pos + 8, size };
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !dataChunk) throw new Error("missing fmt/data chunk");
  const { format, channels, sampleRate, bits } = fmt;
  const bytesPer = bits / 8;
  const frames = Math.floor(dataChunk.size / (bytesPer * channels));
  const buf = createBuf(sampleRate, frames);
  const read = (off: number): number => {
    if (format === 1 && bits === 16) return data.readInt16LE(off) / 0x8000;
    if (format === 1 && bits === 24) {
      const v = (data[off]! | (data[off + 1]! << 8) | (data[off + 2]! << 16)) << 8 >> 8;
      return v / 0x800000;
    }
    if (format === 3 && bits === 32) return data.readFloatLE(off);
    throw new Error(`unsupported wav format=${format} bits=${bits}`);
  };
  for (let i = 0; i < frames; i++) {
    const base = dataChunk.offset + i * bytesPer * channels;
    const l = read(base);
    const r = channels > 1 ? read(base + bytesPer) : l;
    buf.channels[0][i] = l;
    buf.channels[1][i] = r;
  }
  return buf;
}
