/**
 * Groq provider for the params step. Groq is OpenAI-compatible, so we use the
 * official `openai` SDK pointed at Groq's endpoint. Models that support it get
 * strict json_schema decoding; the rest fall back to json_object mode (the
 * prompt already lists every allowed enum value and asks for JSON). The hard
 * guarantee remains the Zod parseParams() call in generate.ts. Imported
 * dynamically so the offline path never loads the SDK.
 */
import { modelInfo, type ParamGenRequest, type ParamLlmProvider } from "./types.ts";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const groqProvider: ParamLlmProvider = {
  name: "groq",
  async generate(req: ParamGenRequest): Promise<unknown> {
    const { default: OpenAI } = await import("openai");
    const client = (req.client as InstanceType<typeof OpenAI>) ??
      new OpenAI({ apiKey: req.apiKey, baseURL: GROQ_BASE_URL });

    const strict = modelInfo("groq", req.model)?.strictJsonSchema ?? false;
    const responseFormat = strict
      ? {
          type: "json_schema" as const,
          json_schema: { name: `${req.kind}_params`, schema: req.jsonSchema, strict: true },
        }
      : { type: "json_object" as const };

    const completion = await client.chat.completions.create(
      {
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        response_format: responseFormat,
      },
      req.signal ? { signal: req.signal } : undefined,
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("Groq returned an empty response");
    try {
      return JSON.parse(content);
    } catch (e) {
      throw new Error(`Groq response was not valid JSON: ${(e as Error).message}`, { cause: e });
    }
  },
};
