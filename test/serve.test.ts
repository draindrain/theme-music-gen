/**
 * Web server: verify the stateless HTTP surface end-to-end on an ephemeral port
 * — capabilities, seed, validation, prompt, the one-shot generate into a job
 * dir, static file serving with traversal/job-id protection, and zip download.
 * Uses dsp + wav-only so it passes in CI without ffmpeg/fluidsynth.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/serve/server.ts";

let server: Server;
let base: string;
let jobsDir: string;

beforeAll(async () => {
  jobsDir = mkdtempSync(join(tmpdir(), "score-jobs-"));
  server = await startServer({ fixturesDir: "fixtures", jobsDir, port: 0 });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(jobsDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

describe("web server", () => {
  it("serves the studio page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Score");
  });

  it("reports capabilities", async () => {
    const res = await fetch(`${base}/api/capabilities`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      backends: { name: string; ok: boolean }[];
      moods: string[];
      models: { provider: string }[];
      formats: string[];
      haveFfmpeg: boolean;
    };
    expect(j.backends.map((b) => b.name)).toContain("dsp");
    expect(j.moods).toContain("tense");
    expect(j.formats).toEqual(["wav", "ogg", "mid"]);
    expect(j.models.map((m) => m.provider)).toContain("anthropic");
  });

  it("seeds descriptions + params from fixtures", async () => {
    const res = await fetch(`${base}/api/seed`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      descriptions: { id: string }[];
      params: Record<string, unknown>;
    };
    expect(j.descriptions.map((d) => d.id)).toContain("nyx");
    expect(j.params.nyx).toBeTruthy();
  });

  it("validates params and returns a typed 400 with the bad path", async () => {
    const ok = await post("/api/validate", {
      kind: "description",
      content: { kind: "character", id: "x", name: "X", description: "d" },
    });
    expect(ok.status).toBe(200);

    const bad = await post("/api/validate", {
      kind: "params",
      content: {
        schemaVersion: 1,
        kind: "character",
        id: "nyx",
        seed: 1,
        key: { tonic: "H", mode: "dorian" }, // H is not a pitch class
        baseTempo: "fast",
        contour: "wave",
        intervals: "leapy",
        rhythm: "syncopated",
        brightness: "neutral",
        weight: "medium",
        palette: { lead: "marimba", harmony: "pluck", bass: "acoustic_guitar", pad: "bright_pad" },
      },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("key.tonic");
  });

  it("builds a copy-paste prompt for a description", async () => {
    const res = await post("/api/prompt", {
      description: {
        kind: "character",
        id: "elara",
        name: "Elara",
        description: "A gentle librarian.",
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { prompt: string }).prompt).toContain("elara");
  });

  it("generates a job (dsp, wav, one mood), serves it, and rejects bad ids", async () => {
    const seed = (await (await fetch(`${base}/api/seed`)).json()) as {
      descriptions: { id: string; kind: string }[];
      params: Record<string, unknown>;
    };
    const desc = seed.descriptions.find((d) => d.id === "nyx")!;
    const res = await post("/api/generate", {
      items: [{ description: desc, params: seed.params.nyx }],
      moods: ["tense"],
      formats: ["wav"],
      backends: ["dsp"],
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      job: string;
      manifest: { assets: { wav: string; mood?: string }[] };
    };
    expect(j.job).toMatch(/^[a-f0-9]{16,}$/);
    const asset = j.manifest.assets.find((a) => a.mood === "tense")!;
    expect(asset.wav).toContain("nyx-tense.dsp.wav");

    const file = await fetch(`${base}/file?job=${j.job}&path=${encodeURIComponent(asset.wav)}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("audio/wav");

    expect((await fetch(`${base}/file?job=zzzz&path=x`)).status).toBe(400);
    expect((await fetch(`${base}/file?job=${j.job}&path=../../package.json`)).status).toBe(404);

    const zip = await fetch(`${base}/api/download?job=${j.job}`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect((await zip.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("rejects ogg when ffmpeg is unavailable, with a clear message", async () => {
    const { haveBinary } = await import("../src/post/post.ts");
    if (haveBinary("ffmpeg")) return; // only meaningful without ffmpeg
    const seed = (await (await fetch(`${base}/api/seed`)).json()) as {
      descriptions: { id: string }[];
      params: Record<string, unknown>;
    };
    const desc = seed.descriptions.find((d) => d.id === "nyx")!;
    const res = await post("/api/generate", {
      items: [{ description: desc, params: seed.params.nyx }],
      moods: ["tense"],
      formats: ["wav", "ogg"],
      backends: ["dsp"],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("ffmpeg");
  });

  it("rejects an empty selection", async () => {
    const res = await post("/api/generate", { items: [], formats: ["wav"], backends: ["dsp"] });
    expect(res.status).toBe(400);
  });
});
