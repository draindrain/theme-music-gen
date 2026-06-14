/**
 * "api" backend: derives a text prompt from the same musical parameters and
 * hands it to a pluggable hosted music-generation provider. Only the
 * deterministic local mock provider ships in v1 — there is no vendor, no key
 * and no network anywhere. A real provider is future config: implement
 * MusicProvider and register it here.
 */
import type { Score } from "../../score/types.ts";
import { loopSeconds } from "../../score/types.ts";
import type { AudioBuf } from "../../audio/buffer.ts";
import type { BackendRender, RenderOpts, SynthBackend } from "../backend.ts";
import { mockProvider } from "./mockProvider.ts";

export interface ProviderRequest {
  prompt: string;
  durationSec: number;
  sampleRate: number;
  seed: number;
}

export interface MusicProvider {
  readonly name: string;
  generate(req: ProviderRequest): Promise<AudioBuf>;
}

const providers = new Map<string, MusicProvider>([[mockProvider.name, mockProvider]]);

export function registerProvider(p: MusicProvider): void {
  providers.set(p.name, p);
}

export function getProvider(name: string): MusicProvider {
  const p = providers.get(name);
  if (!p)
    throw new Error(
      `Unknown api provider "${name}". Available: ${[...providers.keys()].join(", ")}`,
    );
  return p;
}

/** Derive the text prompt a hosted service would receive. Pure function of the Score. */
export function derivePrompt(score: Score): string {
  const moodWords: Record<string, string> = {
    happy: "upbeat, warm, optimistic",
    sad: "slow, mournful, intimate",
    tense: "suspenseful, driving, uneasy",
    tender: "gentle, affectionate, delicate",
    playful: "bouncy, mischievous, light",
    melancholy: "wistful, bittersweet, reflective",
  };
  const instruments = [
    ...new Set(score.tracks.filter((t) => !t.isPercussion).map((t) => t.instrument)),
  ]
    .map((i) => i.replace(/_/g, " "))
    .join(", ");
  return (
    `Instrumental video-game background music, ${moodWords[score.meta.mood]}. ` +
    `Key of ${score.key.tonic} ${score.key.mode.replace("_", " ")}, ${score.tempoBpm} BPM, ${score.beatsPerBar}/4. ` +
    `Featuring ${instruments}. ` +
    `A recurring leitmotif for the subject "${score.meta.subject}" should carry the piece. ` +
    `Seamlessly loopable, no intro or outro, no vocals.`
  );
}

const API_TAIL_SEC = 2;

export function apiProviderName(): string {
  return process.env["SCORE_API_PROVIDER"] ?? "mock";
}

export const apiBackend: SynthBackend = {
  name: "api",
  availability() {
    try {
      getProvider(apiProviderName());
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  },
  async render(score: Score, opts: RenderOpts): Promise<BackendRender> {
    const provider = getProvider(apiProviderName());
    const durationSec = loopSeconds(score) + API_TAIL_SEC;
    const audio = await provider.generate({
      prompt: derivePrompt(score),
      durationSec,
      sampleRate: opts.sampleRate,
      seed: score.meta.seed,
    });
    // Generated audio has no separable tail, so loop by equal-power crossfade.
    return { audio, loop: { kind: "crossfade", fadeSec: API_TAIL_SEC } };
  },
};
