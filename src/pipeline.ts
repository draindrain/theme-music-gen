/**
 * Library-level orchestration: params -> Score -> backend render -> shared
 * post chain -> files on disk (+ manifest for the audition page).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderAmbience, ambienceLoopSamples } from "./ambience/ambience.ts";
import { composeScore } from "./compose/arrange.ts";
import { scoreToMidi } from "./score/midi.ts";
import type { Score } from "./score/types.ts";
import type { CharacterParams, LocationParams, Mood } from "./schema/params.ts";
import { finalizeLoop, type FinalizeResult } from "./post/post.ts";
import { getBackend, registerBackend } from "./synth/backend.ts";
import { dspBackend } from "./synth/dsp/backend.ts";
import { soundfontBackend } from "./synth/soundfont.ts";
import { apiBackend } from "./synth/api/backend.ts";

registerBackend(dspBackend);
registerBackend(soundfontBackend);
registerBackend(apiBackend);

export const DEFAULT_BACKEND = "soundfont";
export const SAMPLE_RATE = 44100;

export interface MusicAsset {
  type: "music";
  character: string;
  mood: Mood;
  backend: string;
  wav: string;
  ogg: string;
  mid: string;
  params: string;
  key: string;
  tempoBpm: number;
  seconds: number;
  rmsDb: number;
}

export interface AmbienceAsset {
  type: "ambience";
  location: string;
  wav: string;
  ogg: string;
  params: string;
  seconds: number;
  rmsDb: number;
}

export type Asset = MusicAsset | AmbienceAsset;

export async function renderMusicAsset(
  params: CharacterParams,
  mood: Mood,
  backendName: string,
  outDir: string,
): Promise<{ asset: MusicAsset; score: Score; result: FinalizeResult }> {
  const backend = getBackend(backendName);
  const avail = backend.availability();
  if (!avail.ok) throw new Error(`Backend "${backendName}" unavailable: ${avail.reason}`);

  const score = composeScore(params, mood);
  const dir = join(outDir, "music", params.id);
  mkdirSync(dir, { recursive: true });

  // params live next to the audio, first-class
  const paramsPath = join(dir, "params.json");
  writeFileSync(paramsPath, JSON.stringify(params, null, 2) + "\n");

  const midPath = join(dir, `${params.id}-${mood}.mid`);
  writeFileSync(midPath, scoreToMidi(score));

  const { audio, loop } = await backend.render(score, { sampleRate: SAMPLE_RATE });
  const outBase = join(dir, `${params.id}-${mood}.${backendName}`);
  const result = finalizeLoop(
    audio,
    outBase,
    loop.kind === "wrap" ? { loopSamples: loop.loopSamples } : { crossfadeSec: loop.fadeSec },
  );

  const asset: MusicAsset = {
    type: "music",
    character: params.id,
    mood,
    backend: backendName,
    wav: result.wavPath,
    ogg: result.oggPath,
    mid: midPath,
    params: paramsPath,
    key: `${score.key.tonic} ${score.key.mode}`,
    tempoBpm: score.tempoBpm,
    seconds: result.seconds,
    rmsDb: result.rmsDb,
  };
  updateManifest(outDir, asset);
  return { asset, score, result };
}

export async function renderAmbienceAsset(
  params: LocationParams,
  outDir: string,
): Promise<{ asset: AmbienceAsset; result: FinalizeResult }> {
  const dir = join(outDir, "ambience");
  mkdirSync(dir, { recursive: true });
  const paramsPath = join(dir, `${params.id}.params.json`);
  writeFileSync(paramsPath, JSON.stringify(params, null, 2) + "\n");

  const raw = renderAmbience(params, SAMPLE_RATE);
  const result = finalizeLoop(raw, join(dir, params.id), {
    loopSamples: ambienceLoopSamples(SAMPLE_RATE),
  });
  const asset: AmbienceAsset = {
    type: "ambience",
    location: params.id,
    wav: result.wavPath,
    ogg: result.oggPath,
    params: paramsPath,
    seconds: result.seconds,
    rmsDb: result.rmsDb,
  };
  updateManifest(outDir, asset);
  return { asset, result };
}

// ---------- manifest ----------

export interface Manifest {
  assets: Asset[];
}

export function manifestPath(outDir: string): string {
  return join(outDir, "manifest.json");
}

export function readManifest(outDir: string): Manifest {
  const p = manifestPath(outDir);
  if (!existsSync(p)) return { assets: [] };
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

function updateManifest(outDir: string, asset: Asset): void {
  const m = readManifest(outDir);
  const keyOf = (a: Asset) =>
    a.type === "music" ? `music/${a.character}/${a.mood}/${a.backend}` : `ambience/${a.location}`;
  m.assets = m.assets.filter((a) => keyOf(a) !== keyOf(asset));
  m.assets.push(asset);
  m.assets.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  mkdirSync(dirname(manifestPath(outDir)), { recursive: true });
  writeFileSync(manifestPath(outDir), JSON.stringify(m, null, 2) + "\n");
}
