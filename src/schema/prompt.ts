/**
 * Prompt templates for the params-via-chatbot workflow. The user pastes the
 * printed prompt into any LLM, then pastes the JSON answer back into
 * `params --ingest`. The tool itself never calls an LLM.
 */
import {
  BRIGHTNESS, CONTOURS, DENSITIES, EVENT_TYPES, INSTRUMENTS, INTERVAL_STYLES,
  LAYER_LEVELS, MODES, PITCH_CLASSES, RHYTHM_FEELS, SPACES, TEMPOS, TEXTURES,
  WEIGHTS, type Description,
} from "./params.ts";

const list = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(" | ");

export function characterPrompt(desc: Description, seed: number): string {
  return `You are translating a subject into musical parameters for a
deterministic leitmotif generator. Read the description, then answer with ONE
JSON object and nothing else. Every field must use exactly one of the allowed
values; do not invent values, do not add fields, do not add comments.

CHARACTER
  id: ${desc.id}
  name: ${desc.name}
  description: ${desc.description}

Guidance:
- key.mode sets the subject's base color (brightest to darkest:
  lydian > ionian > mixolydian > dorian > aeolian > harmonic_minor > phrygian).
  Moods will shift around this base, so pick the subject's *neutral* self.
- contour is the melodic shape of their theme; intervals is how it moves
  (stepwise = smooth/lyrical, leapy = bold/angular).
- rhythm: even = steady, dotted = noble/march-like, syncopated = mischievous,
  flowing = lyrical rubato feel.
- palette: lead carries the theme; harmony plays chords; bass and pad support.
  Choose instruments that match the personality.
- weight: how thick the arrangement should feel by default.

Respond with JSON matching exactly:
{
  "schemaVersion": 1,
  "kind": "character",
  "id": "${desc.id}",
  "seed": ${seed},
  "key": {
    "tonic": ${list(PITCH_CLASSES)},
    "mode": ${list(MODES)}
  },
  "baseTempo": ${list(TEMPOS)},
  "contour": ${list(CONTOURS)},
  "intervals": ${list(INTERVAL_STYLES)},
  "rhythm": ${list(RHYTHM_FEELS)},
  "brightness": ${list(BRIGHTNESS)},
  "weight": ${list(WEIGHTS)},
  "palette": {
    "lead": ${list(INSTRUMENTS)},
    "harmony": ${list(INSTRUMENTS)},
    "bass": ${list(INSTRUMENTS)},
    "pad": ${list(INSTRUMENTS)}
  }
}`;
}

export function locationPrompt(desc: Description, seed: number): string {
  return `You are translating a setting into ambience parameters for a
procedural sound-design generator. Read the description, then answer with ONE
JSON object and nothing else. Every field must use exactly one of the allowed
values; do not invent values, do not add fields, do not add comments.

LOCATION
  id: ${desc.id}
  name: ${desc.name}
  description: ${desc.description}

Guidance:
- layers are continuous textures, 1-3 of them, mixed back-to-front
  (bg = distant wash, fg = close and present).
- events are discrete one-shot sounds sprinkled over the bed; density controls
  how often they occur. Use at most 3, or [] for none.
- space sets reverb/width: tiny = closet, vast = canyon.

Respond with JSON matching exactly:
{
  "schemaVersion": 1,
  "kind": "location",
  "id": "${desc.id}",
  "seed": ${seed},
  "layers": [ { "texture": ${list(TEXTURES)}, "level": ${list(LAYER_LEVELS)} } ],
  "events": [ { "type": ${list(EVENT_TYPES)}, "density": ${list(DENSITIES)} } ],
  "brightness": ${list(BRIGHTNESS)},
  "space": ${list(SPACES)}
}`;
}
