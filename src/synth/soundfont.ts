/**
 * Soundfont backend: renders the Score through the system `fluidsynth`
 * binary with a permissively licensed soundfont (GeneralUser GS by default;
 * its license explicitly allows redistribution inside games).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBuf, type AudioBuf } from "../audio/buffer.ts";
import { decodeWav } from "../audio/wav.ts";
import { scoreToMidi } from "../score/midi.ts";
import { loopBeats, loopSeconds, type Score } from "../score/types.ts";
import { haveBinary } from "../post/post.ts";
import type { BackendRender, RenderOpts, SynthBackend } from "./backend.ts";

export const DEFAULT_SF2_PATH = "vendor/GeneralUser-GS.sf2";
const TAIL_SEC = 3;

export function soundfontPath(): string {
  return resolve(process.env["SCORE_SF2"] ?? DEFAULT_SF2_PATH);
}

export const soundfontBackend: SynthBackend = {
  name: "soundfont",
  availability() {
    if (!haveBinary("fluidsynth")) {
      return {
        ok: false,
        reason:
          "fluidsynth binary not found on PATH. Install it (apt install fluidsynth / brew install fluid-synth).",
      };
    }
    const sf2 = soundfontPath();
    if (!existsSync(sf2)) {
      return {
        ok: false,
        reason: `Soundfont not found at ${sf2}. Run \`pnpm run setup\` to download GeneralUser GS, or point SCORE_SF2 at a .sf2 file.`,
      };
    }
    return { ok: true };
  },
  async render(score: Score, opts: RenderOpts): Promise<BackendRender> {
    const avail = this.availability();
    if (!avail.ok) throw new Error(avail.reason);
    const sr = opts.sampleRate;
    const tailBeats = (TAIL_SEC * score.tempoBpm) / 60;
    const midi = scoreToMidi(score, { padToBeat: loopBeats(score) + tailBeats });
    const dir = mkdtempSync(join(tmpdir(), "score-sf-"));
    try {
      const midPath = join(dir, "score.mid");
      const wavPath = join(dir, "score.wav");
      writeFileSync(midPath, midi);
      execFileSync(
        "fluidsynth",
        ["-ni", "-g", "0.6", "-r", String(sr), "-F", wavPath, soundfontPath(), midPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const audio = fitLength(
        decodeWav(readFileSync(wavPath)),
        Math.round((loopSeconds(score) + TAIL_SEC) * sr),
      );
      return { audio, loop: { kind: "wrap", loopSamples: Math.round(loopSeconds(score) * sr) } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/** Trim or zero-pad to exactly n samples (fluidsynth output length is approximate). */
function fitLength(buf: AudioBuf, n: number): AudioBuf {
  const out = createBuf(buf.sampleRate, n);
  const copyN = Math.min(n, buf.channels[0].length);
  for (let c = 0; c < 2; c++) out.channels[c]!.set(buf.channels[c]!.subarray(0, copyN));
  return out;
}
