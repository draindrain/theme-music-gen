/**
 * Stateless web server: a thin HTTP adapter over the library core. It validates
 * inputs, builds prompts / calls the LLM for params, renders a submitted set of
 * {description, params} items into a short-lived per-request job directory
 * (via the core renderSet), serves those files, and zips them for download.
 *
 * Profiles live in the browser (localStorage); the server keeps no per-user
 * state. All rendering/validation logic stays in the core — every route here
 * just parses a request and delegates. Localhost by default; no auth (yet).
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join, normalize, relative, resolve, sep } from "node:path";
import {
  FORMATS, readManifest, renderSet, RenderRequestError,
  type Format, type Manifest, type RenderItem,
} from "../pipeline.ts";
import {
  MOODS, MoodSchema, parseDescription, parseParams, ParamValidationError,
  PITCH_CLASSES, MODES, TEMPOS, CONTOURS, INTERVAL_STYLES, RHYTHM_FEELS,
  INSTRUMENTS, BRIGHTNESS, WEIGHTS,
  type Description, type Mood, type Params,
} from "../schema/params.ts";
import { characterPrompt, locationPrompt } from "../schema/prompt.ts";
import { generateParams } from "../llm/generate.ts";
import { MODEL_CATALOG } from "../llm/types.ts";
import { listBackends } from "../synth/backend.ts";
import { haveBinary } from "../post/post.ts";
import { hashString } from "../util/prng.ts";
import { cleanupOldJobs, createJob, isJobId, jobDir, zipJob } from "./jobs.ts";
import { PAGE_HTML } from "./page.ts";

export interface ServeOpts {
  fixturesDir: string;
  jobsDir: string;
  port: number;
}

const MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mid": "audio/midi",
  ".json": "application/json",
};

const JOB_TTL_MS = 24 * 60 * 60 * 1000; // discard job dirs after a day

function safeJoin(root: string, rel: string): string | null {
  const abs = resolve(join(root, normalize(rel)));
  return abs.startsWith(resolve(root) + sep) || abs === resolve(root) ? abs : null;
}

/** The default seed the copy-paste flow prints — keep prompts reproducible. */
function defaultSeed(id: string): number {
  return hashString(id) % 0xffffffff;
}

/** Read the bundled fixtures into descriptions + params for the seed profile. */
function readSeed(fixturesDir: string): { descriptions: Description[]; params: Record<string, Params> } {
  const descriptions: Description[] = [];
  const params: Record<string, Params> = {};
  for (const sub of ["characters", "locations"]) {
    const dir = join(fixturesDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.endsWith(".params.json")) continue;
      const descPath = join(dir, f);
      const desc = parseDescription(JSON.parse(readFileSync(descPath, "utf8")), descPath);
      descriptions.push(desc);
      const pPath = join(dir, basename(f, ".json") + ".params.json");
      if (existsSync(pPath)) params[desc.id] = parseParams(JSON.parse(readFileSync(pPath, "utf8")), pPath);
    }
  }
  return { descriptions, params };
}

/** Rewrite a manifest's on-disk paths to be relative to the job dir, so the
 * frontend can fetch them via /file?job=<id>&path=<rel>. */
function relativizeManifest(manifest: Manifest, dir: string): Manifest {
  const rel = (p: string) => relative(dir, resolve(p));
  return {
    assets: manifest.assets.map((a) => ({
      ...a,
      wav: rel(a.wav),
      ...(a.ogg ? { ogg: rel(a.ogg) } : {}),
      ...("mid" in a && a.mid ? { mid: rel(a.mid) } : {}),
      params: rel(a.params),
    })) as Manifest["assets"],
  };
}

export async function startServer(opts: ServeOpts): Promise<import("node:http").Server> {
  const { fixturesDir, jobsDir, port } = opts;
  cleanupOldJobs(jobsDir, JOB_TTL_MS);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: string | Buffer, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    const json = (code: number, obj: unknown) => send(code, JSON.stringify(obj));
    try {
      // ---- static page ----
      if (req.method === "GET" && url.pathname === "/") {
        return send(200, PAGE_HTML, "text/html; charset=utf-8");
      }

      // ---- capabilities: what synths/formats/models are available ----
      if (req.method === "GET" && url.pathname === "/api/capabilities") {
        const backends = listBackends().map((b) => ({ name: b.name, ...b.availability() }));
        return json(200, {
          backends, moods: MOODS, models: MODEL_CATALOG,
          formats: FORMATS, haveFfmpeg: haveBinary("ffmpeg"),
          enums: {
            pitchClasses: PITCH_CLASSES, modes: MODES, tempos: TEMPOS,
            contours: CONTOURS, intervalStyles: INTERVAL_STYLES, rhythmFeels: RHYTHM_FEELS,
            instruments: INSTRUMENTS, brightness: BRIGHTNESS, weights: WEIGHTS,
          },
        });
      }

      // ---- seed: the bundled fixtures for the default profile ----
      if (req.method === "GET" && url.pathname === "/api/seed") {
        return json(200, readSeed(fixturesDir));
      }

      // ---- validate a description or params object ----
      if (req.method === "POST" && url.pathname === "/api/validate") {
        const body = JSON.parse(await readBody(req)) as { kind: "description" | "params"; content: unknown };
        if (body.kind === "description") parseDescription(body.content, "description");
        else parseParams(body.content, "params");
        return json(200, { ok: true });
      }

      // ---- build the copy-paste LLM prompt for a description ----
      if (req.method === "POST" && url.pathname === "/api/prompt") {
        const body = JSON.parse(await readBody(req)) as { description: unknown };
        const desc = parseDescription(body.description, "description");
        const seed = defaultSeed(desc.id);
        const prompt = desc.kind === "character" ? characterPrompt(desc, seed) : locationPrompt(desc, seed);
        return json(200, { prompt });
      }

      // ---- generate params via an LLM (session-only API key) ----
      if (req.method === "POST" && url.pathname === "/api/generate-params") {
        const body = JSON.parse(await readBody(req)) as {
          description: unknown; provider: string; model: string; apiKey: string;
        };
        const desc = parseDescription(body.description, "description");
        if (!body.apiKey) return json(400, { error: "missing API key" });
        try {
          const params = await generateParams({
            providerName: body.provider, model: body.model, apiKey: body.apiKey,
            desc, seed: defaultSeed(desc.id),
          });
          return json(200, { params });
        } catch (e) {
          if (e instanceof ParamValidationError) throw e;
          return json(400, { error: (e as Error).message });
        }
      }

      // ---- the one big call: render the selected set into a job dir ----
      if (req.method === "POST" && url.pathname === "/api/generate") {
        cleanupOldJobs(jobsDir, JOB_TTL_MS);
        const body = JSON.parse(await readBody(req)) as {
          items: { description: unknown; params: unknown }[];
          moods?: string[]; formats?: string[]; backends?: string[];
        };
        if (!Array.isArray(body.items) || body.items.length === 0)
          return json(400, { error: "no items selected to generate" });

        // Re-validate everything server-side — never trust the client payload.
        const items: RenderItem[] = body.items.map((it) => ({
          description: parseDescription(it.description, "description"),
          params: parseParams(it.params, "params"),
        }));
        const moods: Mood[] | undefined = body.moods?.map((m) => MoodSchema.parse(m));
        const formats = (body.formats ?? FORMATS).filter((f): f is Format =>
          (FORMATS as readonly string[]).includes(f));
        if (!formats.includes("wav")) formats.push("wav"); // wav is always emitted
        const backends = body.backends ?? [];

        const { id, dir } = createJob(jobsDir);
        const { manifest } = await renderSet(items, {
          outDir: dir, formats, backends, ...(moods ? { moods } : {}),
        });
        return json(200, { job: id, manifest: relativizeManifest(manifest, dir) });
      }

      // ---- serve a generated file from a job dir ----
      if (req.method === "GET" && url.pathname === "/file") {
        const id = url.searchParams.get("job") ?? "";
        const rel = url.searchParams.get("path") ?? "";
        if (!isJobId(id)) return json(400, { error: "invalid job id" });
        const dir = jobDir(jobsDir, id);
        const abs = safeJoin(dir, rel);
        if (!abs || !existsSync(abs)) return json(404, { error: "not found" });
        return send(200, readFileSync(abs), MIME[extname(abs)] ?? "application/octet-stream");
      }

      // ---- download everything in a job as a zip ----
      if (req.method === "GET" && url.pathname === "/api/download") {
        const id = url.searchParams.get("job") ?? "";
        if (!isJobId(id)) return json(400, { error: "invalid job id" });
        let zipPath: string;
        try {
          zipPath = zipJob(jobsDir, id);
        } catch {
          return json(404, { error: "job not found" });
        }
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="score-${id}.zip"`,
          "cache-control": "no-store",
        });
        const stream = createReadStream(zipPath);
        stream.pipe(res);
        stream.on("close", () => { try { rmSync(zipPath, { force: true }); } catch { /* ignore */ } });
        return;
      }

      json(404, { error: "not found" });
    } catch (e) {
      if (e instanceof ParamValidationError || e instanceof RenderRequestError)
        return json(400, { error: e.message });
      if (e instanceof SyntaxError) return json(400, { error: `invalid JSON: ${e.message}` });
      json(500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  console.log(`score web app: http://localhost:${boundPort}/  (jobs=${resolve(jobsDir)})`);
  return server;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((ok, err) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => ok(data));
    req.on("error", err);
  });
}
