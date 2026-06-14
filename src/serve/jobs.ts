/**
 * Transport-only helpers for the stateless web server: a per-request working
 * directory ("job") that the core renderSet() fills, plus zipping it for
 * download. No composition/synthesis logic lives here — that all stays in the
 * library core (src/pipeline.ts); this module only owns temp dirs and the
 * `zip` shell-out.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const JOB_ID_RE = /^[a-f0-9]{16,}$/;

export function newJobId(): string {
  return randomBytes(12).toString("hex"); // 24 hex chars
}

export function isJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

/** Resolve a job's directory, refusing anything that isn't a clean job id. */
export function jobDir(jobsDir: string, id: string): string {
  if (!isJobId(id)) throw new Error(`invalid job id`);
  const abs = resolve(join(jobsDir, id));
  // Defence in depth: the resolved path must stay under jobsDir.
  if (!abs.startsWith(resolve(jobsDir) + sep)) throw new Error(`invalid job id`);
  return abs;
}

/** Create and return a fresh job directory. */
export function createJob(jobsDir: string): { id: string; dir: string } {
  const id = newJobId();
  const dir = jobDir(jobsDir, id);
  mkdirSync(dir, { recursive: true });
  return { id, dir };
}

/**
 * Zip a job directory into a temp file and return its path. Caller streams it
 * and unlinks it afterwards. Uses the system `zip` binary (same posture as the
 * existing ffmpeg/fluidsynth shell-outs).
 */
export function zipJob(jobsDir: string, id: string): string {
  const dir = jobDir(jobsDir, id);
  if (!existsSync(dir)) throw new Error("job not found");
  const zipPath = join(tmpdir(), `score-${id}.zip`);
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: dir });
  return zipPath;
}

/** Best-effort removal of job dirs older than maxAgeMs. */
export function cleanupOldJobs(jobsDir: string, maxAgeMs: number): void {
  if (!existsSync(jobsDir)) return;
  const now = Date.now();
  for (const name of readdirSync(jobsDir)) {
    if (!isJobId(name)) continue;
    const p = join(jobsDir, name);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore races / permission issues during cleanup
    }
  }
}
