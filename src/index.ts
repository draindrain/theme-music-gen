/** Library entry point: everything the CLI and audition server use. */
export * from "./schema/params.ts";
export * from "./schema/prompt.ts";
export * from "./theory/theory.ts";
export * from "./score/types.ts";
export * from "./score/midi.ts";
export * from "./compose/theme.ts";
export * from "./compose/arrange.ts";
export * from "./ambience/ambience.ts";
export * from "./audio/buffer.ts";
export * from "./audio/wav.ts";
export * from "./post/post.ts";
export * from "./analysis/analyze.ts";
export * from "./synth/backend.ts";
export { dspBackend } from "./synth/dsp/backend.ts";
export { renderScoreDsp, RENDER_TAIL_SEC } from "./synth/dsp/render.ts";
export { PATCHES, GM_PROGRAMS } from "./synth/dsp/instruments.ts";
export { soundfontBackend, soundfontPath, DEFAULT_SF2_PATH } from "./synth/soundfont.ts";
export { apiBackend, derivePrompt, registerProvider, getProvider } from "./synth/api/backend.ts";
export { mockProvider } from "./synth/api/mockProvider.ts";
export * from "./pipeline.ts";
export { Rng, hashString } from "./util/prng.ts";
export {
  MODEL_CATALOG,
  catalogFor,
  modelInfo,
  registerParamProvider,
  getParamProvider,
  listParamProviders,
  type ParamLlmProvider,
  type ParamGenRequest,
  type ParamKind,
  type ModelInfo,
  type ProviderCatalog,
} from "./llm/types.ts";
export {
  CharacterParamsLlmSchema,
  LocationParamsLlmSchema,
  llmSchemaFor,
  toJsonSchema,
} from "./llm/schema.ts";
export { generateParams, type GenerateParamsOptions } from "./llm/generate.ts";
export { anthropicProvider } from "./llm/anthropic.ts";
export { groqProvider } from "./llm/groq.ts";
export { mockParamProvider } from "./llm/mock.ts";
