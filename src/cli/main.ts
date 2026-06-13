#!/usr/bin/env node
/**
 * Thin CLI over the library. Commands:
 *   params <desc.json> [--ingest <json>|-] [--seed n]
 *   compose <subject.json> --mood <mood> [--backend name] [--out dir]
 *   ambience <location.json> [--out dir]
 *   batch <assets-dir> [--backend name|all] [--out dir]
 *   preview --mix <music.wav> <ambience.wav> [--out file]
 *   serve [--out dir] [--fixtures dir] [--port n]
 *   analyze <file.wav> [--key "C ionian"] [--bpm n]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  MOODS, MoodSchema, parseCharacterParams, parseLocationParams, parseDescription,
  ParamValidationError, parseParams,
  type CharacterParams, type LocationParams, type Mood,
} from "../schema/params.ts";
import { characterPrompt, locationPrompt } from "../schema/prompt.ts";
import { DEFAULT_BACKEND, renderAmbienceAsset, renderMusicAsset } from "../pipeline.ts";
import { getBackend, listBackends } from "../synth/backend.ts";
import { decodeWav } from "../audio/wav.ts";
import { createBuf, bufLength } from "../audio/buffer.ts";
import { normalizeLoudness, writeWav, rmsDb, peakDb } from "../post/post.ts";
import {
  detectTempo, inKeyEnergyRatio, loopSeamReport, isEffectivelySilent, tempoMatches,
} from "../analysis/analyze.ts";
import { PITCH_CLASSES, MODES, type PitchClass, type Mode } from "../schema/params.ts";
import { hashString } from "../util/prng.ts";
import { startServer } from "../serve/server.ts";

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else flags.set(key, true);
    } else positional.push(a);
  }
  return { positional, flags };
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) fail(`file not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`could not parse JSON in ${path}: ${(e as Error).message}`);
  }
}

/** elara.json -> elara.params.json (same directory). */
function paramsPathFor(descPath: string): string {
  return join(dirname(descPath), basename(descPath, ".json") + ".params.json");
}

function loadCharacterParams(path: string): CharacterParams {
  const p = path.endsWith(".params.json") ? path : paramsPathFor(path);
  if (!existsSync(p))
    fail(`no parameter file at ${p}. Run \`pnpm params ${path}\` and paste the prompt into your LLM first.`);
  return parseCharacterParams(readJson(p), p);
}

function loadLocationParams(path: string): LocationParams {
  const p = path.endsWith(".params.json") ? path : paramsPathFor(path);
  if (!existsSync(p))
    fail(`no parameter file at ${p}. Run \`pnpm params ${path}\` and paste the prompt into your LLM first.`);
  return parseLocationParams(readJson(p), p);
}

// ---------- commands ----------

async function cmdParams(args: Args): Promise<void> {
  const [descPath] = args.positional;
  if (!descPath) fail("usage: params <subject.json|setting.json> [--ingest <response.json>|-]");
  const desc = parseDescription(readJson(descPath), descPath);
  const outPath = paramsPathFor(descPath);

  const ingest = args.flags.get("ingest");
  if (ingest === undefined) {
    const seedFlag = args.flags.get("seed");
    const seed = typeof seedFlag === "string" ? Number(seedFlag) : hashString(desc.id) % 0xffffffff;
    const prompt = desc.kind === "character" ? characterPrompt(desc, seed) : locationPrompt(desc, seed);
    console.log(prompt);
    console.log(`\n--- paste the LLM's JSON reply into a file (or stdin) and run:`);
    console.log(`    pnpm params ${descPath} --ingest <reply.json>     (or --ingest - for stdin)`);
    return;
  }

  const raw =
    ingest === true || ingest === "-"
      ? JSON.parse(readFileSync(0, "utf8"))
      : readJson(String(ingest));
  const params = parseParams(raw, String(ingest)); // throws ParamValidationError on any out-of-enum value
  if (params.kind !== desc.kind) fail(`params kind "${params.kind}" does not match description kind "${desc.kind}"`);
  if (params.id !== desc.id) fail(`params id "${params.id}" does not match description id "${desc.id}"`);
  writeFileSync(outPath, JSON.stringify(params, null, 2) + "\n");
  console.log(`ok: validated and wrote ${outPath}`);
}

async function cmdCompose(args: Args): Promise<void> {
  const [charPath] = args.positional;
  if (!charPath) fail("usage: compose <subject.json> --mood <mood> [--backend name] [--out dir]");
  const moodRaw = args.flags.get("mood");
  if (typeof moodRaw !== "string") fail(`--mood is required (one of: ${MOODS.join(", ")})`);
  const moodRes = MoodSchema.safeParse(moodRaw);
  if (!moodRes.success) fail(`invalid mood "${moodRaw}" (one of: ${MOODS.join(", ")})`);
  const backend = String(args.flags.get("backend") ?? DEFAULT_BACKEND);
  const outDir = String(args.flags.get("out") ?? "out");
  const params = loadCharacterParams(charPath);
  const { asset } = await renderMusicAsset(params, moodRes.data, backend, outDir);
  console.log(`ok: ${asset.wav}`);
  console.log(`    ${asset.ogg}`);
  console.log(`    ${asset.mid}`);
  console.log(`    key=${asset.key} bpm=${asset.tempoBpm} loop=${asset.seconds.toFixed(2)}s rms=${asset.rmsDb.toFixed(1)}dB`);
}

async function cmdAmbience(args: Args): Promise<void> {
  const [locPath] = args.positional;
  if (!locPath) fail("usage: ambience <location.json> [--out dir]");
  const outDir = String(args.flags.get("out") ?? "out");
  const params = loadLocationParams(locPath);
  const { asset } = await renderAmbienceAsset(params, outDir);
  console.log(`ok: ${asset.wav}`);
  console.log(`    loop=${asset.seconds.toFixed(2)}s rms=${asset.rmsDb.toFixed(1)}dB`);
}

function discoverFixtures(assetsDir: string): { characters: string[]; locations: string[] } {
  const chars = join(assetsDir, "characters");
  const locs = join(assetsDir, "locations");
  const listDescs = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".json") && !f.endsWith(".params.json"))
          .map((f) => join(dir, f))
      : [];
  return { characters: listDescs(chars), locations: listDescs(locs) };
}

async function cmdBatch(args: Args): Promise<void> {
  const [assetsDir] = args.positional;
  if (!assetsDir) fail("usage: batch <assets-dir> [--backend name|all] [--out dir]");
  const outDir = String(args.flags.get("out") ?? "out");
  const backendFlag = args.flags.get("backend");

  let backends: string[];
  if (typeof backendFlag === "string" && backendFlag !== "all") {
    const b = getBackend(backendFlag);
    const avail = b.availability();
    if (!avail.ok) fail(`backend "${backendFlag}" unavailable: ${avail.reason}`);
    backends = [backendFlag];
  } else {
    const wanted = backendFlag === "all" ? listBackends().map((b) => b.name) : ["soundfont", "dsp"];
    backends = [];
    for (const name of wanted) {
      const avail = getBackend(name).availability();
      if (avail.ok) backends.push(name);
      else console.warn(`warning: skipping backend "${name}": ${avail.reason}`);
    }
    if (backends.length === 0) fail("no synthesis backend available");
  }

  const { characters, locations } = discoverFixtures(assetsDir);
  if (characters.length === 0 && locations.length === 0)
    fail(`no fixtures found under ${assetsDir} (expected characters/*.json and locations/*.json)`);

  const t0 = Date.now();
  let count = 0;
  for (const charPath of characters) {
    const params = loadCharacterParams(charPath);
    for (const mood of MOODS) {
      for (const backend of backends) {
        const { asset } = await renderMusicAsset(params, mood, backend, outDir);
        count++;
        console.log(`[${count}] music    ${params.id}/${mood} (${backend})  ${asset.seconds.toFixed(1)}s  rms ${asset.rmsDb.toFixed(1)}dB`);
      }
    }
  }
  for (const locPath of locations) {
    const params = loadLocationParams(locPath);
    const { asset } = await renderAmbienceAsset(params, outDir);
    count++;
    console.log(`[${count}] ambience ${params.id}  ${asset.seconds.toFixed(1)}s  rms ${asset.rmsDb.toFixed(1)}dB`);
  }
  console.log(`\ndone: ${count} assets in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${resolve(outDir)}`);
}

async function cmdPreview(args: Args): Promise<void> {
  const mix = args.flags.get("mix");
  if (mix === undefined) fail("usage: preview --mix <music.wav> <ambience.wav> [--out preview.wav]");
  // --mix consumes the next arg as its value; the rest are positional
  const files = [typeof mix === "string" ? mix : null, ...args.positional].filter(
    (f): f is string => f !== null,
  );
  if (files.length !== 2) fail("preview --mix needs exactly two wav files (music, ambience)");
  const [musicPath, ambPath] = files as [string, string];
  const music = decodeWav(readFileSync(musicPath));
  const amb = decodeWav(readFileSync(ambPath));
  if (music.sampleRate !== amb.sampleRate) fail("sample rates differ");
  const n = Math.max(bufLength(music), bufLength(amb));
  const out = createBuf(music.sampleRate, n);
  const ambGain = 0.5; // game-style: ambience sits ~6 dB under the music
  for (let c = 0; c < 2; c++) {
    const o = out.channels[c]!, m = music.channels[c]!, a = amb.channels[c]!;
    for (let i = 0; i < n; i++)
      o[i] = m[i % m.length]! + a[i % a.length]! * ambGain; // both loop to fill
  }
  const outPath = String(args.flags.get("out") ?? "preview.wav");
  writeWav(normalizeLoudness(out), outPath);
  console.log(`ok: ${outPath} (${(n / out.sampleRate).toFixed(1)}s)`);
}

async function cmdAnalyze(args: Args): Promise<void> {
  const [wavPath] = args.positional;
  if (!wavPath) fail("usage: analyze <file.wav> [--key 'C ionian'] [--bpm n]");
  const buf = decodeWav(readFileSync(wavPath));
  const seam = loopSeamReport(buf);
  console.log(`file:      ${wavPath}`);
  console.log(`duration:  ${(bufLength(buf) / buf.sampleRate).toFixed(3)}s @ ${buf.sampleRate}Hz`);
  console.log(`rms:       ${rmsDb(buf).toFixed(2)} dBFS   peak: ${peakDb(buf).toFixed(2)} dBFS`);
  console.log(`silent:    ${isEffectivelySilent(buf)}`);
  console.log(`loop seam: jump=${seam.boundaryJump.toFixed(4)} slope=${seam.slopeJump.toFixed(4)} ratio=${seam.seamRatio.toFixed(2)} -> ${seam.pass ? "PASS" : "FAIL"}`);
  const keyFlag = args.flags.get("key");
  if (typeof keyFlag === "string") {
    const [tonic, mode] = keyFlag.split(/\s+/) as [string, string];
    if (!PITCH_CLASSES.includes(tonic as PitchClass) || !MODES.includes(mode as Mode))
      fail(`invalid --key "${keyFlag}"`);
    const ratio = inKeyEnergyRatio(buf, { tonic: tonic as PitchClass, mode: mode as Mode });
    console.log(`in-key energy (${keyFlag}): ${(ratio * 100).toFixed(1)}%`);
  }
  const bpmFlag = args.flags.get("bpm");
  const t = detectTempo(buf);
  const conf = t.confidence < 0.4 ? " (low confidence — flat beat spectrum)" : "";
  console.log(`tempo:     detected ${t.bpm.toFixed(1)} bpm, confidence ${t.confidence.toFixed(2)}${conf}` +
    (typeof bpmFlag === "string" ? `  declared ${bpmFlag} -> ${tempoMatches(t.bpm, Number(bpmFlag)) ? "MATCH" : "MISMATCH"}` : ""));
}

async function cmdServe(args: Args): Promise<void> {
  const outDir = String(args.flags.get("out") ?? "out");
  const fixturesDir = String(args.flags.get("fixtures") ?? "fixtures");
  const port = Number(args.flags.get("port") ?? 4321);
  await startServer({ outDir, fixturesDir, port });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case "params": return await cmdParams(args);
      case "compose": return await cmdCompose(args);
      case "ambience": return await cmdAmbience(args);
      case "batch": return await cmdBatch(args);
      case "preview": return await cmdPreview(args);
      case "analyze": return await cmdAnalyze(args);
      case "serve": return await cmdServe(args);
      default:
        console.error(
          "usage: score <params|compose|ambience|batch|preview|analyze|serve> ...\n" +
          "  params   <desc.json> [--ingest reply.json|-]   print LLM prompt / validate+store reply\n" +
          "  compose  <subject.json> --mood <mood> [--backend dsp|soundfont|api]\n" +
          "  ambience <setting.json>\n" +
          "  batch    <assets-dir> [--backend name|all] [--out dir]\n" +
          "  preview  --mix <music.wav> <ambience.wav>\n" +
          "  analyze  <file.wav> [--key 'C ionian'] [--bpm 96]\n" +
          "  serve    [--out out] [--fixtures fixtures] [--port 4321]",
        );
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    if (e instanceof ParamValidationError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
}

await main();
