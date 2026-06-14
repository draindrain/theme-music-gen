/**
 * Swappable synthesis backends. Every backend turns a Score into raw audio
 * plus a "how to make it loop" instruction; the shared post chain does the
 * rest, so the output contract (seamless loop at target loudness, WAV+OGG)
 * is identical regardless of backend.
 */
import type { AudioBuf } from "../audio/buffer.ts";
import type { Score } from "../score/types.ts";

export type LoopStrategy =
  | { kind: "wrap"; loopSamples: number }
  | { kind: "crossfade"; fadeSec: number };

export interface BackendRender {
  audio: AudioBuf;
  loop: LoopStrategy;
}

export interface RenderOpts {
  sampleRate: number;
}

export interface SynthBackend {
  readonly name: string;
  /** Check external requirements (binaries, soundfont files...). */
  availability(): { ok: true } | { ok: false; reason: string };
  render(score: Score, opts: RenderOpts): Promise<BackendRender>;
}

const registry = new Map<string, SynthBackend>();

export function registerBackend(b: SynthBackend): void {
  registry.set(b.name, b);
}

export function getBackend(name: string): SynthBackend {
  const b = registry.get(name);
  if (!b) {
    throw new Error(`Unknown backend "${name}". Available: ${[...registry.keys()].join(", ")}`);
  }
  return b;
}

export function listBackends(): SynthBackend[] {
  return [...registry.values()];
}
