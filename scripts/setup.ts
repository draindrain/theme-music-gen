/**
 * One-time setup: verify system binaries and download the GeneralUser GS
 * soundfont for the default `soundfont` backend.
 *
 * GeneralUser GS is distributed under the GeneralUser GS License v2.0, which
 * permits using the bank to render music for any purpose, including
 * commercial games, and redistributing it (credit appreciated). See
 * https://github.com/mrbumpy409/GeneralUser-GS/blob/main/LICENSE.txt
 * This is the only network access in the entire tool, and it happens here,
 * at setup time — never at generation time.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

const SF2_URL = "https://github.com/mrbumpy409/GeneralUser-GS/raw/main/GeneralUser-GS.sf2";
const SF2_PATH = process.env["SCORE_SF2"] ?? "vendor/GeneralUser-GS.sf2";
const MIN_SF2_BYTES = 20_000_000;

function have(bin: string): boolean {
  for (const flag of ["-version", "--version"]) {
    try {
      execFileSync(bin, [flag], { stdio: "ignore" });
      return true;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") return false;
      // Binary exists but exited non-zero — that's fine, it ran.
      return true;
    }
  }
  return false;
}

let failures = 0;

function check(name: string, ok: boolean, hint: string): void {
  console.log(`${ok ? "  ok " : "MISSING"}  ${name}${ok ? "" : `\n         -> ${hint}`}`);
  if (!ok) failures++;
}

const major = Number(process.versions.node.split(".")[0]);
check("node >= 22", major >= 22, "install Node 22+ (https://nodejs.org)");
check(
  "ffmpeg (OGG encoding)",
  have("ffmpeg"),
  "apt install ffmpeg | brew install ffmpeg | winget install Gyan.FFmpeg",
);
check(
  "fluidsynth (soundfont backend)",
  have("fluidsynth"),
  "apt install fluidsynth | brew install fluid-synth | scoop install fluidsynth",
);

if (existsSync(SF2_PATH) && statSync(SF2_PATH).size > MIN_SF2_BYTES) {
  console.log(`  ok   soundfont at ${SF2_PATH} (${(statSync(SF2_PATH).size / 1e6).toFixed(1)} MB)`);
} else {
  console.log(`  ..   downloading GeneralUser GS soundfont -> ${SF2_PATH}`);
  try {
    const res = await fetch(SF2_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < MIN_SF2_BYTES)
      throw new Error(`file too small (${bytes.length} bytes) — download corrupted?`);
    mkdirSync(dirname(SF2_PATH), { recursive: true });
    writeFileSync(SF2_PATH, bytes);
    writeFileSync(
      "vendor/GeneralUser-GS.LICENSE.txt",
      "GeneralUser GS by S. Christian Collins, GeneralUser GS License v2.0.\n" +
        "The license permits rendering music for any purpose (including commercial\n" +
        "games) and redistribution of the bank. Full text:\n" +
        "https://github.com/mrbumpy409/GeneralUser-GS/blob/main/LICENSE.txt\n",
    );
    console.log(
      `  ok   downloaded ${(bytes.length / 1e6).toFixed(1)} MB (GeneralUser GS License v2.0 — game redistribution permitted)`,
    );
  } catch (e) {
    console.log(`MISSING  soundfont download failed: ${(e as Error).message}`);
    console.log(`         -> download manually from ${SF2_URL} and save as ${SF2_PATH}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(
    `\nsetup incomplete (${failures} issue${failures > 1 ? "s" : ""}). The pure-TS "dsp" backend works regardless; fix the above for soundfont/OGG.`,
  );
  process.exit(1);
}
console.log("\nsetup complete. Try: pnpm batch ./fixtures");
