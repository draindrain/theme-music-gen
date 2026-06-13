/**
 * The full parameter space an LLM (talked to by the user, outside this tool)
 * maps descriptions into. Everything is an enum or a bounded integer so the
 * mapping is auditable and out-of-range values are typed errors.
 */
import { z } from "zod";

// ---------- shared enums ----------

export const PITCH_CLASSES = [
  "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
] as const;
export const PitchClassSchema = z.enum(PITCH_CLASSES);
export type PitchClass = z.infer<typeof PitchClassSchema>;

export const MODES = [
  "lydian", "ionian", "mixolydian", "dorian", "aeolian", "harmonic_minor", "phrygian",
] as const;
export const ModeSchema = z.enum(MODES);
export type Mode = z.infer<typeof ModeSchema>;

export const MOODS = ["happy", "sad", "tense", "tender", "playful", "melancholy"] as const;
export const MoodSchema = z.enum(MOODS);
export type Mood = z.infer<typeof MoodSchema>;

export const TEMPOS = ["very_slow", "slow", "medium", "fast", "very_fast"] as const;
export const TempoSchema = z.enum(TEMPOS);
export type TempoClass = z.infer<typeof TempoSchema>;

export const CONTOURS = ["rising", "falling", "arch", "valley", "wave", "static"] as const;
export const ContourSchema = z.enum(CONTOURS);
export type Contour = z.infer<typeof ContourSchema>;

export const INTERVAL_STYLES = ["stepwise", "mixed", "leapy"] as const;
export const IntervalStyleSchema = z.enum(INTERVAL_STYLES);
export type IntervalStyle = z.infer<typeof IntervalStyleSchema>;

export const RHYTHM_FEELS = ["even", "dotted", "syncopated", "flowing"] as const;
export const RhythmFeelSchema = z.enum(RHYTHM_FEELS);
export type RhythmFeel = z.infer<typeof RhythmFeelSchema>;

export const INSTRUMENTS = [
  "piano", "electric_piano", "music_box", "celesta", "harp", "acoustic_guitar",
  "pluck", "marimba", "vibraphone", "flute", "clarinet", "oboe",
  "strings", "cello", "warm_pad", "bright_pad", "soft_choir", "bells",
] as const;
export const InstrumentSchema = z.enum(INSTRUMENTS);
export type Instrument = z.infer<typeof InstrumentSchema>;

export const BRIGHTNESS = ["dark", "neutral", "bright"] as const;
export const BrightnessSchema = z.enum(BRIGHTNESS);
export type Brightness = z.infer<typeof BrightnessSchema>;

export const WEIGHTS = ["light", "medium", "heavy"] as const;
export const WeightSchema = z.enum(WEIGHTS);
export type Weight = z.infer<typeof WeightSchema>;

const SeedSchema = z.number().int().min(0).max(0xffffffff);
const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be a lowercase slug");

// ---------- character ----------

export const CharacterParamsSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("character"),
    id: IdSchema,
    seed: SeedSchema,
    key: z.object({ tonic: PitchClassSchema, mode: ModeSchema }).strict(),
    baseTempo: TempoSchema,
    contour: ContourSchema,
    intervals: IntervalStyleSchema,
    rhythm: RhythmFeelSchema,
    brightness: BrightnessSchema,
    weight: WeightSchema,
    palette: z
      .object({
        lead: InstrumentSchema,
        harmony: InstrumentSchema,
        bass: InstrumentSchema,
        pad: InstrumentSchema,
      })
      .strict(),
  })
  .strict();
export type CharacterParams = z.infer<typeof CharacterParamsSchema>;

// ---------- location / ambience ----------

export const TEXTURES = [
  "rain", "wind", "crowd_murmur", "night_insects", "water_stream",
  "room_tone", "fire", "seaside", "city_hum",
] as const;
export const TextureSchema = z.enum(TEXTURES);
export type Texture = z.infer<typeof TextureSchema>;

export const LAYER_LEVELS = ["bg", "mid", "fg"] as const;
export const LayerLevelSchema = z.enum(LAYER_LEVELS);
export type LayerLevel = z.infer<typeof LayerLevelSchema>;

export const EVENT_TYPES = [
  "droplets", "clinks", "birds", "owl", "frogs", "creaks",
  "chimes", "distant_thunder", "footsteps", "pages", "crickets_chirp", "gull",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type AmbEventType = z.infer<typeof EventTypeSchema>;

export const DENSITIES = ["sparse", "occasional", "frequent"] as const;
export const DensitySchema = z.enum(DENSITIES);
export type Density = z.infer<typeof DensitySchema>;

export const SPACES = ["tiny", "room", "open", "vast"] as const;
export const SpaceSchema = z.enum(SPACES);
export type Space = z.infer<typeof SpaceSchema>;

export const LocationParamsSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("location"),
    id: IdSchema,
    seed: SeedSchema,
    layers: z
      .array(z.object({ texture: TextureSchema, level: LayerLevelSchema }).strict())
      .min(1)
      .max(3),
    events: z
      .array(z.object({ type: EventTypeSchema, density: DensitySchema }).strict())
      .max(3),
    brightness: BrightnessSchema,
    space: SpaceSchema,
  })
  .strict();
export type LocationParams = z.infer<typeof LocationParamsSchema>;

export const ParamsSchema = z.discriminatedUnion("kind", [
  CharacterParamsSchema,
  LocationParamsSchema,
]);
export type Params = z.infer<typeof ParamsSchema>;

// ---------- description files (the human-authored inputs) ----------

export const DescriptionSchema = z
  .object({
    kind: z.enum(["character", "location"]),
    id: IdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type Description = z.infer<typeof DescriptionSchema>;

// ---------- typed validation error ----------

export class ParamValidationError extends Error {
  constructor(
    public readonly issues: { path: string; message: string }[],
    source: string,
  ) {
    super(
      `Invalid parameter file (${source}):\n` +
        issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n"),
    );
    this.name = "ParamValidationError";
  }
}

export function parseParams(json: unknown, source = "input"): Params {
  const res = ParamsSchema.safeParse(json);
  if (!res.success) {
    throw new ParamValidationError(
      res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      source,
    );
  }
  return res.data;
}

export function parseCharacterParams(json: unknown, source = "input"): CharacterParams {
  const p = parseParams(json, source);
  if (p.kind !== "character")
    throw new ParamValidationError([{ path: "kind", message: "expected kind=character" }], source);
  return p;
}

export function parseLocationParams(json: unknown, source = "input"): LocationParams {
  const p = parseParams(json, source);
  if (p.kind !== "location")
    throw new ParamValidationError([{ path: "kind", message: "expected kind=location" }], source);
  return p;
}

export function parseDescription(json: unknown, source = "input"): Description {
  const res = DescriptionSchema.safeParse(json);
  if (!res.success) {
    throw new ParamValidationError(
      res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      source,
    );
  }
  return res.data;
}
