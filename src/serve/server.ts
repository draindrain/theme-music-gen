/**
 * Local audition server: lists every generated asset with players, shows the
 * parameter file beside each track, A/B across backends, and re-renders after
 * parameter edits. Localhost-only by design; no auth, no hosting.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { readManifest } from "../pipeline.ts";
import { renderAmbienceAsset, renderMusicAsset } from "../pipeline.ts";
import {
  MOODS, MoodSchema, parseCharacterParams, parseLocationParams, parseParams,
  ParamValidationError,
} from "../schema/params.ts";
import { listBackends } from "../synth/backend.ts";
import { PAGE_HTML } from "./page.ts";

export interface ServeOpts {
  outDir: string;
  fixturesDir: string;
  port: number;
}

const MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mid": "audio/midi",
  ".json": "application/json",
};

function safeJoin(root: string, rel: string): string | null {
  const abs = resolve(join(root, normalize(rel)));
  return abs.startsWith(resolve(root) + sep) || abs === resolve(root) ? abs : null;
}

export async function startServer(opts: ServeOpts): Promise<import("node:http").Server> {
  const { outDir, fixturesDir, port } = opts;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: string | Buffer, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return send(200, PAGE_HTML, "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const manifest = readManifest(outDir);
        const backends = listBackends().map((b) => ({ name: b.name, ...b.availability() }));
        return send(200, JSON.stringify({ manifest, backends, moods: MOODS, outDir, fixturesDir }));
      }
      if (req.method === "GET" && url.pathname === "/file") {
        // serves files referenced by the manifest (under outDir) or fixtures.
        // Try each root, falling through when the resolved path doesn't exist
        // (safeJoin only guards against traversal, not existence).
        const rel = url.searchParams.get("path") ?? "";
        let abs: string | null = null;
        for (const root of [outDir, fixturesDir]) {
          const cand = safeJoin(resolve(root), relTo(rel, root));
          if (cand && existsSync(cand)) { abs = cand; break; }
        }
        if (!abs) return send(404, JSON.stringify({ error: "not found" }));
        return send(200, readFileSync(abs), MIME[extname(abs)] ?? "application/octet-stream");
      }
      if (req.method === "POST" && url.pathname === "/api/params") {
        const body = JSON.parse(await readBody(req)) as { id: string; kind: string; content: unknown };
        const params = parseParams(body.content, "edited params"); // typed error on any out-of-enum value
        if (params.id !== body.id) return send(400, JSON.stringify({ error: "id mismatch" }));
        const file = join(
          fixturesDir,
          params.kind === "character" ? "characters" : "locations",
          `${params.id}.params.json`,
        );
        writeFileSync(file, JSON.stringify(params, null, 2) + "\n");
        return send(200, JSON.stringify({ ok: true, file }));
      }
      if (req.method === "POST" && url.pathname === "/api/regenerate") {
        const body = JSON.parse(await readBody(req)) as {
          type: "music" | "ambience"; id: string; mood?: string; backend?: string;
        };
        if (body.type === "music") {
          const p = join(fixturesDir, "characters", `${body.id}.params.json`);
          const params = parseCharacterParams(JSON.parse(readFileSync(p, "utf8")), p);
          const mood = MoodSchema.parse(body.mood);
          const backend = body.backend ?? "dsp";
          const { asset } = await renderMusicAsset(params, mood, backend, outDir);
          return send(200, JSON.stringify({ ok: true, asset }));
        }
        const p = join(fixturesDir, "locations", `${body.id}.params.json`);
        const params = parseLocationParams(JSON.parse(readFileSync(p, "utf8")), p);
        const { asset } = await renderAmbienceAsset(params, outDir);
        return send(200, JSON.stringify({ ok: true, asset }));
      }
      send(404, JSON.stringify({ error: "not found" }));
    } catch (e) {
      const msg = e instanceof ParamValidationError ? e.message : (e as Error).message;
      send(e instanceof ParamValidationError ? 400 : 500, JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  console.log(`audition page: http://localhost:${boundPort}/  (out=${resolve(outDir)})`);
  return server;
}

/** Manifest paths may be "out/music/..." or absolute; make them relative to root. */
function relTo(p: string, root: string): string {
  const abs = resolve(p);
  const r = resolve(root);
  if (abs.startsWith(r + sep)) return abs.slice(r.length + 1);
  return p;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((ok, err) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => ok(data));
    req.on("error", err);
  });
}
