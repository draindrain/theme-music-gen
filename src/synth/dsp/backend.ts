import type { Score } from "../../score/types.ts";
import { loopSeconds } from "../../score/types.ts";
import type { BackendRender, RenderOpts, SynthBackend } from "../backend.ts";
import { renderScoreDsp } from "./render.ts";

export const dspBackend: SynthBackend = {
  name: "dsp",
  availability() {
    return { ok: true }; // pure TypeScript, always available
  },
  async render(score: Score, opts: RenderOpts): Promise<BackendRender> {
    const audio = renderScoreDsp(score, { sampleRate: opts.sampleRate });
    return {
      audio,
      loop: { kind: "wrap", loopSamples: Math.round(loopSeconds(score) * opts.sampleRate) },
    };
  },
};
