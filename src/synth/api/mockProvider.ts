/**
 * Deterministic local stand-in for a hosted music-generation service.
 * Produces plausible-but-simple audio (a chordal drone with movement) purely
 * from the prompt hash + seed, so the api backend's full pipeline — prompt
 * derivation, render, loop crossfade, normalization — is testable offline.
 */
import { createBuf, type AudioBuf } from "../../audio/buffer.ts";
import { Rng, hashString } from "../../util/prng.ts";
import type { MusicProvider, ProviderRequest } from "./backend.ts";

export const mockProvider: MusicProvider = {
  name: "mock",
  async generate(req: ProviderRequest): Promise<AudioBuf> {
    const sr = req.sampleRate;
    const n = Math.round(req.durationSec * sr);
    const buf = createBuf(sr, n);
    const rng = new Rng(hashString(req.prompt) ^ req.seed);

    // pull a base frequency + tempo-ish pulse out of the prompt hash
    const root = 110 * Math.pow(2, rng.int(12) / 12);
    const partials = [1, 1.5, 2, 2.5, 3].map((r) => ({
      ratio: r,
      amp: 0.3 / r,
      lfo: rng.range(0.05, 0.2),
      pan: rng.range(-0.5, 0.5),
    }));
    const pulseHz = rng.range(1.2, 2.4);

    for (let c = 0; c < 2; c++) {
      const x = buf.channels[c]!;
      let lp = 0;
      const chRng = rng.fork(`ch${c}`);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let s = 0;
        for (const p of partials) {
          const g = c === 0 ? 1 - Math.max(0, p.pan) : 1 + Math.min(0, p.pan);
          s +=
            Math.sin(2 * Math.PI * root * p.ratio * t) *
            p.amp *
            g *
            (0.6 + 0.4 * Math.sin(2 * Math.PI * p.lfo * t + p.ratio));
        }
        const w = chRng.next() * 2 - 1;
        lp += 0.03 * (w - lp);
        const pulse = 0.75 + 0.25 * Math.sin(2 * Math.PI * pulseHz * t);
        x[i] = (s + lp * 0.4) * pulse * 0.5;
      }
    }
    return buf;
  },
};
