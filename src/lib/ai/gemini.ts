import { GoogleGenAI } from "@google/genai";

// Thin, typed wrapper over @google/genai (verified against the official
// Gemini API + js-genai references, Sep 2026). Server-side only — the API key
// must never leave the server. All failures surface as AiProviderError so the
// router can fall back or fail safely.

export class AiProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "AiProviderError";
  }
}

/** Retry transient overload/rate-limit errors (429/503) — but never daily
 * quota exhaustion (retries can't help and only burn quota faster). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const msg = error instanceof Error ? error.message : "";
      if (/PerDay|per day|daily/i.test(msg)) throw error;
      const transient = /"(code|status)"\s*:\s*(429|503)|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(msg);
      if (!transient || i === attempts - 1) throw error;
      await new Promise((r) => setTimeout(r, 15_000 * (i + 1)));
    }
  }
  throw last;
}

export interface GeminiModels {
  generation: string;
  embedding: string;
}

function models(): GeminiModels {
  return {
    generation: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
    embedding: process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001",
  };
}

export class GeminiClient {
  private constructor(private readonly ai: GoogleGenAI) {}

  /** Explicit-key constructor (tests, scripts). Prefer fromEnv in app code. */
  static withApiKey(apiKey: string): GeminiClient {
    return new GeminiClient(new GoogleGenAI({ apiKey }));
  }

  static fromEnv(): GeminiClient {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new AiProviderError(
        "gemini",
        "GEMINI_API_KEY is not set. Add it to .env.local (see .env.example).",
      );
    }
    return new GeminiClient(new GoogleGenAI({ apiKey: key }));
  }

  static isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  /** Structured JSON output enforced by a plain JSON Schema object. */
  async generateStructured(
    prompt: string,
    jsonSchema: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await withRetry(async () => {
        const response = await this.ai.models.generateContent({
          model: models().generation,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
            temperature: 0,
          },
        });
        const text = response.text;
        if (!text) throw new Error("empty response");
        return JSON.parse(text) as unknown;
      });
    } catch (error) {
      throw new AiProviderError(
        "gemini",
        error instanceof Error ? error.message : "generateStructured failed",
      );
    }
  }

  async generateText(prompt: string, maxOutputTokens = 1024): Promise<string> {
    try {
      return await withRetry(async () => {
        const response = await this.ai.models.generateContent({
          model: models().generation,
          contents: prompt,
          config: { temperature: 0.2, maxOutputTokens },
        });
        const text = response.text;
        if (!text) throw new Error("empty response");
        return text;
      });
    } catch (error) {
      throw new AiProviderError(
        "gemini",
        error instanceof Error ? error.message : "generateText failed",
      );
    }
  }

  /** Embedding vectors truncated to the pgvector column width (1536). */
  async embed(
    texts: string[],
    taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "CLASSIFICATION",
  ): Promise<number[][]> {
    try {
      return await withRetry(async () => {
        const response = await this.ai.models.embedContent({
          model: models().embedding,
          // NOTE: autoTruncate is Enterprise-only; the Developer API rejects it.
          // Inputs are truncated in code instead (see callers / knowledge.ts).
          contents: texts.map((t) => t.slice(0, 8000)),
          config: { taskType, outputDimensionality: 1536 },
        });
        const out = response.embeddings ?? [];
        if (out.length !== texts.length) {
          throw new Error(`expected ${texts.length} embeddings, got ${out.length}`);
        }
        return out.map((e, i) => {
          const values = e.values ?? [];
          if (values.length !== 1536) {
            throw new Error(`embedding ${i} has ${values.length} dims, expected 1536`);
          }
          return values;
        });
      });
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError(
        "gemini",
        error instanceof Error ? error.message : "embed failed",
      );
    }
  }
}
