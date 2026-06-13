/**
 * Audition server: verify the thin HTTP surface end-to-end on an ephemeral
 * port — state, static file serving with traversal protection, regenerate,
 * and that invalid params are rejected with a typed 400 (no silent pass
 * through the server path).
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/serve/server.ts";

let server: Server;
let base: string;

beforeAll(async () => {
  server = await startServer({ outDir: "out", fixturesDir: "fixtures", port: 0 });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe("audition server", () => {
  it("serves the audition page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Score");
  });

  it("reports manifest + backend availability via /api/state", async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { backends: { name: string }[]; moods: string[] };
    expect(j.backends.map((b) => b.name)).toContain("dsp");
    expect(j.moods).toContain("tense");
  });

  it("serves fixture params (page-style path) and blocks path traversal", async () => {
    // the audition page requests params as e.g. "characters/<id>.params.json";
    // the server must fall through outDir to the fixtures root to find them
    const ok = await fetch(`${base}/file?path=characters/nyx.params.json`);
    expect(ok.status).toBe(200);
    const params = (await ok.json()) as { id: string };
    expect(params.id).toBe("nyx");

    const bad = await fetch(`${base}/file?path=../package.json`);
    expect(bad.status).toBe(404);
  });

  it("regenerates a music asset on demand (dsp)", async () => {
    const res = await fetch(`${base}/api/regenerate`, {
      method: "POST",
      body: JSON.stringify({ type: "music", id: "nyx", mood: "tense", backend: "dsp" }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; asset: { wav: string } };
    expect(j.ok).toBe(true);
    expect(j.asset.wav).toContain("nyx-tense.dsp.wav");
  });

  it("rejects out-of-enum params with a typed 400 (never a silent pass)", async () => {
    const res = await fetch(`${base}/api/params`, {
      method: "POST",
      body: JSON.stringify({
        id: "nyx", kind: "character",
        content: {
          schemaVersion: 1, kind: "character", id: "nyx", seed: 1,
          key: { tonic: "H", mode: "dorian" }, // H is not a pitch class
          baseTempo: "fast", contour: "wave", intervals: "leapy", rhythm: "syncopated",
          brightness: "neutral", weight: "medium",
          palette: { lead: "marimba", harmony: "pluck", bass: "acoustic_guitar", pad: "bright_pad" },
        },
      }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toContain("key.tonic");
  });
});
