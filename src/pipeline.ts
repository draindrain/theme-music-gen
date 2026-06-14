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
import {
  MOODS,
  type CharacterParams,
  type Description,
  type LocationParams,
  type Mood,
  type Params,
} from "./schema/params.ts";
import { finalizeLoop, haveBinary, type FinalizeResult } from "./post/post.ts";
import { getBackend, registerBackend } from "./synth/backend.ts";
import { dspBackend } from "./synth/dsp/backend.ts";
import { soundfontBackend } from "./synth/soundfont.ts";
import { apiBackend } from "./synth/api/backend.ts";

registerBackend(dspBackend);
registerBackend(soundfontBackend);
registerBackend(apiBackend);

export const DEFAULT_BACKEND = "soundfont";
export const SAMPLE_RATE = 44100;

/** Output file formats. WAV is always emitted; OGG/MID are opt-in. */
export const FORMATS = ["wav", "ogg", "mid"] as const;
export type Format = (typeof FORMATS)[number];
const ALL_FORMATS: readonly Format[] = FORMATS;

/** Per-render output options shared by the music/ambience render functions. */
export interface RenderFormatOpts {
  /** Which formats to write. Defaults to all; "wav" is always included. */
  formats?: readonly Format[];
}

export interface MusicAsset {
  type: "music";
  subject: string;
  mood: Mood;
  backend: string;
  wav: string;
  ogg?: string;
  mid?: string;
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
  ogg?: string;
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
  opts: RenderFormatOpts = {},
): Promise<{ asset: MusicAsset; score: Score; result: FinalizeResult }> {
  const formats = opts.formats ?? ALL_FORMATS;
  const backend = getBackend(backendName);
  const avail = backend.availability();
  if (!avail.ok) throw new Error(`Backend "${backendName}" unavailable: ${avail.reason}`);

  const score = composeScore(params, mood);
  const dir = join(outDir, "music", params.id);
  mkdirSync(dir, { recursive: true });

  // params live next to the audio, first-class
  const paramsPath = join(dir, "params.json");
  writeFileSync(paramsPath, JSON.stringify(params, null, 2) + "\n");

  let midPath: string | undefined;
  if (formats.includes("mid")) {
    midPath = join(dir, `${params.id}-${mood}.mid`);
    writeFileSync(midPath, scoreToMidi(score));
  }

  const { audio, loop } = await backend.render(score, { sampleRate: SAMPLE_RATE });
  const outBase = join(dir, `${params.id}-${mood}.${backendName}`);
  const loopOpt =
    loop.kind === "wrap" ? { loopSamples: loop.loopSamples } : { crossfadeSec: loop.fadeSec };
  const result = finalizeLoop(audio, outBase, { ...loopOpt, ogg: formats.includes("ogg") });

  const asset: MusicAsset = {
    type: "music",
    subject: params.id,
    mood,
    backend: backendName,
    wav: result.wavPath,
    ...(result.oggPath ? { ogg: result.oggPath } : {}),
    ...(midPath ? { mid: midPath } : {}),
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
  opts: RenderFormatOpts = {},
): Promise<{ asset: AmbienceAsset; result: FinalizeResult }> {
  const formats = opts.formats ?? ALL_FORMATS;
  const dir = join(outDir, "ambience");
  mkdirSync(dir, { recursive: true });
  const paramsPath = join(dir, `${params.id}.params.json`);
  writeFileSync(paramsPath, JSON.stringify(params, null, 2) + "\n");

  const raw = renderAmbience(params, SAMPLE_RATE);
  const result = finalizeLoop(raw, join(dir, params.id), {
    loopSamples: ambienceLoopSamples(SAMPLE_RATE),
    ogg: formats.includes("ogg"),
  });
  const asset: AmbienceAsset = {
    type: "ambience",
    location: params.id,
    wav: result.wavPath,
    ...(result.oggPath ? { ogg: result.oggPath } : {}),
    params: paramsPath,
    seconds: result.seconds,
    rmsDb: result.rmsDb,
  };
  updateManifest(outDir, asset);
  return { asset, result };
}

// ---------- render set (shared by the CLI `batch` and the web `/api/generate`) ----------

/** A description paired with its already-validated parameters. */
export interface RenderItem {
  description: Description;
  params: Params;
}

export interface RenderSetOptions {
  outDir: string;
  /** Music moods to render per character. Defaults to all six. */
  moods?: readonly Mood[];
  /** Output formats. Defaults to all; "wav" is always emitted. */
  formats?: readonly Format[];
  /** Synthesis backends for characters. Required when any character is present. */
  backends?: readonly string[];
  /** Optional per-asset progress hook (e.g. CLI logging). */
  onProgress?: (asset: Asset) => void;
}

/**
 * A request-level problem the caller (CLI or HTTP) should surface as a 4xx /
 * usage error rather than an internal failure: empty selection, an unavailable
 * backend/format, or a params/description mismatch.
 */
export class RenderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderRequestError";
  }
}

/**
 * Transport-free core: render a set of `{description, params}` items into
 * `outDir` (characters across moods × backends, locations once), writing each
 * description JSON beside its params so the directory is self-contained.
 * Both the CLI `batch` command and the server's `/api/generate` call this.
 */
export async function renderSet(
  items: readonly RenderItem[],
  options: RenderSetOptions,
): Promise<{ manifest: Manifest }> {
  const { outDir } = options;
  const moods = options.moods ?? MOODS;
  const formats = options.formats ?? ALL_FORMATS;
  const backends = options.backends ?? [];

  if (items.length === 0) throw new RenderRequestError("no items selected to generate");
  if (moods.length === 0) throw new RenderRequestError("no moods selected");

  // Validate consistency and availability up front, before doing any work.
  for (const { description, params } of items) {
    if (params.kind !== description.kind)
      throw new RenderRequestError(
        `params kind "${params.kind}" does not match description kind "${description.kind}" for "${description.id}"`,
      );
    if (params.id !== description.id)
      throw new RenderRequestError(
        `params id "${params.id}" does not match description id "${description.id}"`,
      );
  }
  const hasCharacters = items.some((i) => i.description.kind === "character");
  if (hasCharacters && backends.length === 0)
    throw new RenderRequestError("no synthesis backend selected");
  for (const name of backends) {
    const avail = getBackend(name).availability();
    if (!avail.ok) throw new RenderRequestError(`backend "${name}" unavailable: ${avail.reason}`);
  }
  if (formats.includes("ogg") && !haveBinary("ffmpeg"))
    throw new RenderRequestError(
      'OGG output requires ffmpeg, which was not found on PATH. Deselect "ogg" or install ffmpeg.',
    );

  for (const { description, params } of items) {
    if (description.kind === "character" && params.kind === "character") {
      const dir = join(outDir, "music", description.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${description.id}.json`),
        JSON.stringify(description, null, 2) + "\n",
      );
      for (const mood of moods)
        for (const backend of backends) {
          const { asset } = await renderMusicAsset(params, mood, backend, outDir, { formats });
          options.onProgress?.(asset);
        }
    } else if (description.kind === "location" && params.kind === "location") {
      const dir = join(outDir, "ambience");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${description.id}.json`),
        JSON.stringify(description, null, 2) + "\n",
      );
      const { asset } = await renderAmbienceAsset(params, outDir, { formats });
      options.onProgress?.(asset);
    }
  }

  return { manifest: readManifest(outDir) };
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
    a.type === "music" ? `music/${a.subject}/${a.mood}/${a.backend}` : `ambience/${a.location}`;
  m.assets = m.assets.filter((a) => keyOf(a) !== keyOf(asset));
  m.assets.push(asset);
  m.assets.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  mkdirSync(dirname(manifestPath(outDir)), { recursive: true });
  writeFileSync(manifestPath(outDir), JSON.stringify(m, null, 2) + "\n");
}
