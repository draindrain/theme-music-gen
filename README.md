# Score — a leitmotif and ambience generator

Generate a full set of looping audio cues from a handful of small JSON files:
**one looping music track per subject per mood**, and **one looping ambience
track per setting**. Works for games, tabletop RPG session music, interactive
fiction, podcast backgrounds, audio branding, film scoring tools — run one
batch command and get a finished soundtrack: WAV + OGG + MIDI for every cue.

```bash
pnpm install && pnpm setup && pnpm batch ./fixtures
pnpm serve            # web studio: build, generate, audition & download in the browser
```

## Use cases

The two primitives — leitmotif tracks and ambience beds — cover a wide range of projects:

| Project type          | Subjects                     | Settings                      |
| --------------------- | ---------------------------- | ----------------------------- |
| Visual novel          | Characters                   | Locations                     |
| Game OST (any genre)  | Factions, bosses, heroes     | Biomes, dungeons              |
| Tabletop RPG session  | NPCs, factions               | Taverns, wilderness, dungeons |
| Podcast / audio drama | Recurring guests, storylines | Scene changes                 |
| Interactive fiction   | Protagonists, antagonists    | Rooms, acts                   |
| Audio branding        | Brand voices, product lines  | Environments                  |

The included fixtures use a visual novel as the example; they work out of the box and illustrate the workflow.

## What it is

- **Leitmotifs, not independent songs.** Each subject has a single musical
  identity — a short melodic theme, key, tempo, instrument palette — derived
  from their description. Each _mood_ is an arrangement/variation of that same
  theme, so the subject stays recognizable from happy to melancholy. This
  theme-and-variations system is the heart of the tool.
- **The LLM measures, the code composes.** Translating a prose description into
  musical parameters is the one place an LLM is involved (see
  [the params workflow](#the-params-via-chatbot-workflow)). The tool defines a
  strict schema, ships the prompt, and validates the JSON. **All** composition
  and synthesis is deterministic code. By default the LLM lives _outside_ the
  tool — you paste the prompt into any chatbot — but you can optionally let the
  tool call Anthropic or Groq directly (still just to produce the params JSON).
- **Offline and keyless by default.** With the copy-paste workflow the only
  network access anywhere is `pnpm setup` downloading a soundfont, once. Same
  seed + same params = byte-identical audio. The optional direct-LLM params path
  is the single exception — it's opt-in, needs an API key, and only runs when
  you ask for it.
- **Music and ambience are separate stems** — mix them at runtime at whatever level suits the project.

### Pipeline

```
description.json  ──(you + any LLM)──▶  params.json   (strict, enum-only, hand-editable)
                                            │
                              deterministic compose  ──▶  Score IR (notes/tracks/structure)
                                            │
                          swappable synth backend (dsp │ soundfont │ api)
                                            │
            shared post: seamless loop ─▶ loudness-normalize ─▶ WAV + OGG   (+ MIDI export)
```

## Requirements

- **Node 22+** and **pnpm**.
- **fluidsynth** — for the default `soundfont` backend. (`apt install fluidsynth`
  / `brew install fluid-synth` / `scoop install fluidsynth`)
- **ffmpeg** — for OGG encoding. (`apt install ffmpeg` / `brew install ffmpeg`
  / `winget install Gyan.FFmpeg`)
- **zip** — only for the web studio's "download all" button. (Usually preinstalled;
  `apt install zip` / `brew install zip`.)

**Windows:** [Scoop](https://scoop.sh) covers both in one command:

```powershell
scoop install ffmpeg fluidsynth
```

Open a new terminal afterwards so the updated PATH reaches `pnpm setup`.

`pnpm setup` checks for these, downloads the GeneralUser GS soundfont into
`vendor/`, and tells you exactly what to install if anything is missing. The
pure-TypeScript `dsp` backend works with zero external tools, so you can always
generate _something_ even before setup.

## Commands

All commands are thin wrappers over the importable library (`src/index.ts`);
the CLI and the audition server add no logic of their own.

| Command                                                                      | What it does                                                                                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm params <desc.json>`                                                    | In a terminal, offer a choice: print the prompt to copy-paste, or generate directly via Anthropic/Groq. Piped/non-interactive, it just prints the prompt. |
| `pnpm params <desc.json> --ingest <reply.json>`                              | Validate a pasted JSON reply and store it as `<desc>.params.json`. Use `--ingest -` to read from stdin.                                                   |
| `pnpm params <desc.json> --provider <anthropic\|groq> [--model <id>]`        | Generate params directly via an LLM. Reads `ANTHROPIC_API_KEY` / `GROQ_API_KEY`, or prompts (hidden) in a terminal.                                       |
| `pnpm compose <subject.json> --mood <mood> [--backend <name>] [--out <dir>]` | Render one music cue.                                                                                                                                     |
| `pnpm ambience <setting.json> [--out <dir>]`                                 | Render one ambience bed.                                                                                                                                  |
| `pnpm batch <assets-dir> [--backend <name>\|all] [--out <dir>]`              | Render every subject × every mood, plus every setting.                                                                                                    |
| `pnpm preview --mix <music.wav> <ambience.wav> [--out <file>]`               | Mix a music + ambience pair for a quick listen.                                                                                                           |
| `pnpm serve [--fixtures <dir>] [--jobs <dir>] [--port <n>]`                  | Web studio: run the whole pipeline from the browser (see below).                                                                                          |
| `pnpm analyze <file.wav> [--key "C ionian"] [--bpm <n>]`                     | Run the audio analysis harness on any WAV.                                                                                                                |
| `pnpm verify [<out-dir>]`                                                    | Re-analyze every asset in a manifest and report pass/fail.                                                                                                |

- **Moods:** `happy`, `sad`, `tense`, `tender`, `playful`, `melancholy`.
- **Backends:** `dsp`, `soundfont` (default), `api`. `--backend all` renders all
  available backends; `batch` with no flag renders `soundfont` + `dsp` so you can
  A/B them. Unavailable backends are skipped with a clear reason.

## Parameter file format

Parameters are first-class, human-editable JSON artifacts, stored next to the
audio they produce. The full space is defined and validated by the Zod schemas
in [`src/schema/params.ts`](src/schema/params.ts) — **every field is an enum or a
bounded integer**, so an out-of-range value is a typed error
(`ParamValidationError`), never a silent pass.

A **subject** (drives music):

```json
{
  "schemaVersion": 1,
  "kind": "character",
  "id": "elara",
  "seed": 19087411,
  "key": { "tonic": "F", "mode": "lydian" },
  "baseTempo": "slow",
  "contour": "arch",
  "intervals": "stepwise",
  "rhythm": "flowing",
  "brightness": "bright",
  "weight": "light",
  "palette": {
    "lead": "music_box",
    "harmony": "harp",
    "bass": "acoustic_guitar",
    "pad": "warm_pad"
  }
}
```

A **location** (drives ambience):

```json
{
  "schemaVersion": 1,
  "kind": "location",
  "id": "night-forest",
  "seed": 31337602,
  "layers": [
    { "texture": "night_insects", "level": "fg" },
    { "texture": "wind", "level": "mid" }
  ],
  "events": [
    { "type": "owl", "density": "sparse" },
    { "type": "frogs", "density": "occasional" }
  ],
  "brightness": "dark",
  "space": "vast"
}
```

`seed` makes generation reproducible; edit any field by hand and re-render to
hear the change. The enums (modes, tempos, contours, instruments, textures,
events, …) are the single source of truth in `src/schema/params.ts`.

## The params-via-chatbot workflow

By default the tool never calls an LLM — you drive it:

1. Write a short description file (see [`fixtures/characters/elara.json`](fixtures/characters/elara.json)):
   ```json
   {
     "kind": "character",
     "id": "elara",
     "name": "Elara",
     "description": "A gentle apprentice librarian…"
   }
   ```
2. Print the prompt and paste it into **any** chatbot:
   ```bash
   pnpm params fixtures/characters/elara.json
   ```
   The prompt embeds the description and the entire allowed value space, and asks
   for a single JSON object. (Run in a terminal, this also offers to generate
   directly — see below.)
3. Save the chatbot's JSON reply and ingest it — this validates against the
   schema and writes `elara.params.json` next to the description:
   ```bash
   pnpm params fixtures/characters/elara.json --ingest reply.json
   ```
   Any out-of-enum value is rejected with the offending field path.

The repo fixtures already ship with authored `*.params.json` files (written with
this same workflow), so `pnpm batch ./fixtures` works out of the box with **no
LLM step**.

### Optional: generate params directly

If you'd rather not copy-paste, the tool can call an LLM for you. This is the
only opt-in network/key use in the project; the validated output is identical
to the pasted-in path (the Zod schema is still the hard gate, with one automatic
corrective retry on a bad answer).

```bash
# Non-interactive: key from env, model from the flag (or the provider default)
GROQ_API_KEY=…      pnpm params fixtures/characters/elara.json --provider groq --model openai/gpt-oss-120b
ANTHROPIC_API_KEY=… pnpm params fixtures/characters/elara.json --provider anthropic --model claude-sonnet-4-6

# Interactive: a terminal run with no flags shows a menu (copy-paste / Anthropic
# / Groq), then a model picker, then prompts for the key (hidden) if no env var.
pnpm params fixtures/characters/elara.json
```

The API key is read from `ANTHROPIC_API_KEY` / `GROQ_API_KEY`, or prompted for
without echoing — it is never written to disk, the params file, or logs.

**Models** (`src/llm/types.ts`, verified June 2026 — Groq drifts, re-check
[console.groq.com/docs/models](https://console.groq.com/docs/models)):

- **Anthropic** — `claude-sonnet-4-6` (balanced, default), `claude-opus-4-8`
  (best taste), `claude-haiku-4-5` (cheapest).
- **Groq** — `openai/gpt-oss-120b` (cheap default, strict JSON),
  `moonshotai/kimi-k2-instruct-0905` (strongest), `llama-3.3-70b-versatile`,
  the Llama-4 models, `qwen3-32b`, `openai/gpt-oss-20b`, `llama-3.1-8b-instant`.

Strict-JSON-capable models decode against the schema directly; the rest use
JSON-object mode plus the schema spelled out in the prompt.

## The web studio (`pnpm serve`)

`pnpm serve` runs the **whole pipeline from the browser** — you don't need to run
`pnpm batch` first. The server is a thin, stateless adapter over the same library
the CLI uses (it calls the shared `renderSet` core); it keeps no per-user state.

In the page you can:

- **Profiles** — create or switch between named profiles. Each profile holds its
  own characters/locations, their parameters, and generation settings. Profiles
  are saved in the **browser's localStorage**; API keys are kept **in memory for
  the session only** (never written to disk or localStorage). On first load a
  `default` profile is seeded from the bundled fixtures.
- **Descriptions** — add characters/locations with a form, or import description
  JSON files. Everything is validated server-side.
- **Parameters, three ways** per description — upload a `*.params.json` file, copy
  a generated prompt into any chatbot and paste the reply back, or enter an API
  key and generate them directly via Anthropic/Groq.
- **Generate** — pick which subjects, which formats (`wav`/`ogg`/`mid`), and which
  synths (`dsp`/`soundfont`/`api`) to render. One request renders the whole set
  into a short-lived per-request job directory and serves it back.
- **Audition & download** — browse and play every cue (A/B across backends), then
  **download everything as a single zip** (descriptions + parameters + audio).

Notes: localhost-only and no auth for now (it's built so auth can be added later).
OGG output needs `ffmpeg` and the `soundfont` synth needs `fluidsynth`; both are
offered only when available. The **download** button shells out to the `zip`
binary. Job directories live under `--jobs` (default `jobs/`, gitignored) and are
cleaned up automatically after a day.

## Backends, and how to add one

Every backend implements one interface and returns audio plus a loop strategy;
the shared post-processing guarantees the identical output contract (seamless
loop at target loudness, WAV + OGG) regardless of backend.

- **`dsp`** — pure from-scratch synthesis (oscillators, FM, Karplus–Strong,
  envelopes, a one-pole filter, a Schroeder reverb) → PCM → WAV. Zero external
  dependencies; always available; used in tests.
- **`soundfont`** _(default)_ — renders the Score's MIDI through `fluidsynth`
  with the GeneralUser GS soundfont.
- **`api`** — derives a text prompt from the same parameters and sends it to a
  pluggable hosted music-generation provider. v1 ships only a deterministic
  local **mock** provider, so the whole path is testable with no vendor, no key,
  and no network. A real provider is future config.

**Add a synthesis backend:** implement `SynthBackend` in
[`src/synth/backend.ts`](src/synth/backend.ts) (an `availability()` check and a
`render(score, opts)` returning `{ audio, loop }`) and register it in
[`src/pipeline.ts`](src/pipeline.ts).

**Add an `api` provider:** implement `MusicProvider` and register it in
[`src/synth/api/backend.ts`](src/synth/api/backend.ts); select it with the
`SCORE_API_PROVIDER` env var.

**MIDI export** is produced for every music cue
([`src/score/midi.ts`](src/score/midi.ts)), so compositions are never trapped in
this tool.

## Self-verification

Claims about the audio are checked, not asserted:

- `pnpm test` — unit tests for composition (scale membership, voice-leading
  movement bounds, leitmotif identity across moods, cross-character
  distinctness), the audio post chain (incl. a **negative** loop-seam control
  that must fail), per-backend render contracts, MIDI structure, and the serve
  endpoints.
- `pnpm verify` — walks the generated manifest and re-analyzes every WAV:
  duration, loudness vs target, loop-seam continuity, FFT in-key energy, and
  tempo detection.
- `pnpm analyze <file.wav>` — run the same harness on any single file.

The analysis harness lives in [`src/analysis/analyze.ts`](src/analysis/analyze.ts)
(radix-2 FFT, chroma/key profile, spectral-flux tempo detection with a
confidence measure, loop-seam click detector).

## Licensing note

`pnpm setup` downloads **GeneralUser GS** (S. Christian Collins), distributed
under the GeneralUser GS License v2.0, which permits rendering music for any
purpose — including commercial games — and redistributing the bank. The license
text is saved alongside the download in `vendor/`.

## Known weaknesses (honest)

- **Tempo detection on fully legato material** (e.g. some `sad`/`tender`
  arrangements of slow characters) has a low-confidence, sometimes off-by-an-
  octave beat spectrum — there simply isn't a strong periodic onset to lock to.
  `pnpm verify` gates on a confidence measure rather than failing these, and the
  audio itself is correct.
- **Ambience is procedural sound design**, not recordings; some beds are subtler
  than others (wind and the forest bed are gentle), and events are stylized
  rather than realistic.
- The `api` backend is wired end-to-end but only against the local mock
  provider; plugging in a real service is intentionally left as future config.

## Project layout

```
src/
  schema/      param Zod schemas + the LLM prompt templates
  theory/      scales, diatonic chords, voice leading
  compose/     leitmotif generation (theme.ts) + mood arrangement (arrange.ts)
  score/       the Score IR (types.ts) + MIDI export (midi.ts)
  synth/       backend interface + dsp / soundfont / api backends
  ambience/    procedural location ambience engine
  audio/       in-memory buffers + WAV codec
  post/        seamless loop, loudness normalization, OGG encode
  analysis/    the audio analysis harness (FFT, key, tempo, loop seam)
  serve/       the web studio: stateless HTTP server + page + per-request job dirs
  cli/         the CLI surface
  pipeline.ts  params → Score → render → post → files (+ manifest); renderSet() core
fixtures/      example subjects (visual novel characters) and settings (locations), with authored *.params.json
scripts/       setup.ts (download soundfont), verify.ts (analyze the manifest)
test/          vitest suites
```
