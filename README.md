# Score — a leitmotif soundtrack generator for visual novels

Generate the entire audio bed for a visual novel from a handful of small JSON
files: **one looping music track per character per mood**, and **one looping
ambience track per location**. Run one batch command and get a finished
soundtrack — WAV + OGG + MIDI for every cue.

```bash
pnpm install && pnpm setup && pnpm batch ./fixtures
pnpm serve            # then open the printed http://localhost:… to audition
```

## What it is

- **Leitmotifs, not independent songs.** Each character has a single musical
  identity — a short melodic theme, key, tempo, instrument palette — derived
  from their description. Each *mood* is an arrangement/variation of that same
  theme, so the character stays recognizable from happy to melancholy. This
  theme-and-variations system is the heart of the tool.
- **The LLM measures, the code composes — and the LLM lives outside the tool.**
  Translating a prose description into musical parameters is done by an LLM
  *you* talk to (see [the params workflow](#the-params-via-chatbot-workflow)).
  The tool only defines a strict schema, ships the prompt, and validates what
  you paste back. **All** composition and synthesis is deterministic code.
- **No network, no API keys at runtime.** The only network access anywhere is
  `pnpm setup` downloading a soundfont, once. Same seed + same params =
  byte-identical audio.
- **Music and ambience are separate stems** — the game mixes them at runtime.

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
  / `brew install fluid-synth`)
- **ffmpeg** — for OGG encoding. (`apt install ffmpeg` / `brew install ffmpeg`)

`pnpm setup` checks for these, downloads the GeneralUser GS soundfont into
`vendor/`, and tells you exactly what to install if anything is missing. The
pure-TypeScript `dsp` backend works with zero external tools, so you can always
generate *something* even before setup.

## Commands

All commands are thin wrappers over the importable library (`src/index.ts`);
the CLI and the audition server add no logic of their own.

| Command | What it does |
| --- | --- |
| `pnpm params <desc.json>` | Print the LLM prompt for a character/location description. |
| `pnpm params <desc.json> --ingest <reply.json>` | Validate the LLM's JSON reply and store it as `<desc>.params.json`. Use `--ingest -` to read from stdin. |
| `pnpm compose <character.json> --mood <mood> [--backend <name>] [--out <dir>]` | Render one music cue. |
| `pnpm ambience <location.json> [--out <dir>]` | Render one location ambience bed. |
| `pnpm batch <assets-dir> [--backend <name>\|all] [--out <dir>]` | Render every character × every mood, plus every location. |
| `pnpm preview --mix <music.wav> <ambience.wav> [--out <file>]` | Mix a music + ambience pair the way the game would, for a quick listen. |
| `pnpm serve [--out <dir>] [--fixtures <dir>] [--port <n>]` | Local audition page (see below). |
| `pnpm analyze <file.wav> [--key "C ionian"] [--bpm <n>]` | Run the audio analysis harness on any WAV. |
| `pnpm verify [<out-dir>]` | Re-analyze every asset in a manifest and report pass/fail. |

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

A **character** (drives music):

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
  "palette": { "lead": "music_box", "harmony": "harp", "bass": "acoustic_guitar", "pad": "warm_pad" }
}
```

A **location** (drives ambience):

```json
{
  "schemaVersion": 1,
  "kind": "location",
  "id": "night-forest",
  "seed": 31337602,
  "layers": [ { "texture": "night_insects", "level": "fg" }, { "texture": "wind", "level": "mid" } ],
  "events": [ { "type": "owl", "density": "sparse" }, { "type": "frogs", "density": "occasional" } ],
  "brightness": "dark",
  "space": "vast"
}
```

`seed` makes generation reproducible; edit any field by hand and re-render to
hear the change. The enums (modes, tempos, contours, instruments, textures,
events, …) are the single source of truth in `src/schema/params.ts`.

## The params-via-chatbot workflow

The tool never calls an LLM. You drive it:

1. Write a short description file (see [`fixtures/characters/elara.json`](fixtures/characters/elara.json)):
   ```json
   { "kind": "character", "id": "elara", "name": "Elara", "description": "A gentle apprentice librarian…" }
   ```
2. Print the prompt and paste it into **any** chatbot:
   ```bash
   pnpm params fixtures/characters/elara.json
   ```
   The prompt embeds the description and the entire allowed value space, and asks
   for a single JSON object.
3. Save the chatbot's JSON reply and ingest it — this validates against the
   schema and writes `elara.params.json` next to the description:
   ```bash
   pnpm params fixtures/characters/elara.json --ingest reply.json
   ```
   Any out-of-enum value is rejected with the offending field path.

The repo fixtures already ship with authored `*.params.json` files (written with
this same workflow), so `pnpm batch ./fixtures` works out of the box with **no
LLM step**.

## The audition page (`pnpm serve`)

A localhost-only page (no auth, no hosting) that, from the manifest:

- lists every generated asset with an inline audio player;
- shows the parameter file beside each track;
- lets you **A/B the same character/mood across backends** side by side;
- has a **regenerate** button that re-renders after you edit parameters in the
  browser (validated server-side — invalid edits are rejected, not saved).

## Backends, and how to add one

Every backend implements one interface and returns audio plus a loop strategy;
the shared post-processing guarantees the identical output contract (seamless
loop at target loudness, WAV + OGG) regardless of backend.

- **`dsp`** — pure from-scratch synthesis (oscillators, FM, Karplus–Strong,
  envelopes, a one-pole filter, a Schroeder reverb) → PCM → WAV. Zero external
  dependencies; always available; used in tests.
- **`soundfont`** *(default)* — renders the Score's MIDI through `fluidsynth`
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
  serve/       the audition server + page
  cli/         the CLI surface
  pipeline.ts  params → Score → render → post → files (+ manifest)
fixtures/      3 characters, 3 locations, with authored *.params.json
scripts/       setup.ts (download soundfont), verify.ts (analyze the manifest)
test/          vitest suites
```
