/**
 * Post-batch verification sweep: walk the manifest and run the analysis
 * harness on every generated WAV. Exits non-zero if any asset fails its
 * loop-seam, loudness, duration, silence, key or tempo check.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import {
  detectTempo, inKeyEnergyRatio, isEffectivelySilent, loopSeamReport, tempoMatches,
} from "../src/analysis/analyze.ts";

/** Below this beat-spectrum contrast a blind tempo estimate is noise. */
const TEMPO_CONFIDENCE_GATE = 0.4;
import { bufLength } from "../src/audio/buffer.ts";
import { decodeWav } from "../src/audio/wav.ts";
import { rmsDb, TARGET_RMS_DB } from "../src/post/post.ts";
import { readManifest } from "../src/pipeline.ts";
import { MODES, PITCH_CLASSES, type Mode, type PitchClass } from "../src/schema/params.ts";

const outDir = process.argv[2] ?? "out";
const manifest = readManifest(outDir);
if (manifest.assets.length === 0) {
  console.error(`no assets in ${outDir}/manifest.json — run \`pnpm batch ./fixtures\` first`);
  process.exit(1);
}

let failures = 0;
console.log(`verifying ${manifest.assets.length} assets in ${outDir}\n`);
console.log("asset".padEnd(38), "dur(s)".padStart(7), "rms".padStart(7), "seam".padStart(6), "key%".padStart(6), "bpm".padStart(11), " result");

for (const asset of manifest.assets) {
  const buf = decodeWav(readFileSync(asset.wav));
  const problems: string[] = [];

  const dur = bufLength(buf) / buf.sampleRate;
  if (Math.abs(dur - asset.seconds) > 0.01) problems.push("duration");
  if (isEffectivelySilent(buf)) problems.push("silent");
  const rms = rmsDb(buf);
  if (Math.abs(rms - TARGET_RMS_DB) > 0.75) problems.push(`loudness(${rms.toFixed(1)})`);
  const seam = loopSeamReport(buf);
  if (!seam.pass) problems.push(`seam(jump=${seam.boundaryJump.toFixed(3)})`);

  let keyPct = "";
  let bpmInfo = "";
  if (asset.type === "music") {
    const [tonic, mode] = asset.key.split(" ") as [PitchClass, Mode];
    if (PITCH_CLASSES.includes(tonic) && MODES.includes(mode)) {
      const ratio = inKeyEnergyRatio(buf, { tonic, mode });
      keyPct = (ratio * 100).toFixed(0);
      if (ratio < 0.7) problems.push(`key(${keyPct}%)`);
    }
    const t = detectTempo(buf);
    if (t.confidence >= TEMPO_CONFIDENCE_GATE) {
      bpmInfo = `${t.bpm.toFixed(0)}/${asset.tempoBpm}`;
      if (!tempoMatches(t.bpm, asset.tempoBpm)) problems.push(`tempo(${bpmInfo})`);
    } else {
      bpmInfo = `~/${asset.tempoBpm}`; // flat beat spectrum: estimate unreliable
    }
  }

  const name = asset.type === "music" ? `${asset.character}/${asset.mood} (${asset.backend})` : `ambience/${asset.location}`;
  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(
    name.padEnd(38),
    dur.toFixed(1).padStart(7),
    rms.toFixed(1).padStart(7),
    seam.boundaryJump.toFixed(3).padStart(6),
    keyPct.padStart(6),
    bpmInfo.padStart(11),
    ok ? "  ok" : `  FAIL: ${problems.join(", ")}`,
  );
}

console.log(failures === 0 ? `\nall ${manifest.assets.length} assets verified.` : `\n${failures} asset(s) FAILED verification.`);
process.exit(failures === 0 ? 0 : 1);
