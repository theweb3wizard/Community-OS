import { z } from "zod";

import type { StructuredDecision } from "./structured";

// Jev adapter (TypeSafe System One decision model) via the OpenRouter
// Decisions API — request/response shapes verified against OpenRouter's
// published OpenAPI for POST /api/alpha/decisions (Sep 2026).
// Auth is an OpenRouter API key (JEV_API_KEY). Jev returns typed answers
// only (no prose): the reasoningSummary below is composed deterministically
// in code from the returned probabilities, never generated.

const ChoiceAnswer = z
  .object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number().optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

const NoulAnswer = z
  .object({ type: z.literal("noul"), noul: z.number() })
  .passthrough();

const ScoreAnswer = z
  .object({
    type: z.literal("score"),
    score: z.number(),
    confidence: z.number().optional(),
  })
  .passthrough();

const DecisionsResponse = z
  .object({
    answers: z.object({
      category: ChoiceAnswer,
      needs_human: NoulAnswer,
      urgency: ScoreAnswer,
    }).passthrough(),
  })
  .passthrough();

const CATEGORIES = ["NORMAL", "SPAM", "PHISHING", "SUPPORT", "ESCALATE"] as const;

export class JevError extends Error {
  constructor(message: string) {
    super(`jev: ${message}`);
    this.name = "JevError";
  }
}

export interface JevConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export function jevConfigFromEnv(): JevConfig | null {
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.JEV_MODEL ?? "typesafe/jev-1.13",
    baseUrl: (process.env.JEV_BASE_URL ?? "https://openrouter.ai").replace(/\/+$/, ""),
  };
}

const CATEGORY_CRITERIA: Record<string, string> = {
  NORMAL: "Ordinary conversation, greetings, on-topic discussion.",
  SPAM: "Unsolicited bulk content, ads, repetitive promos, link dumps.",
  PHISHING: "Impersonation, fake giveaways, wallet-drainer lures, credential theft.",
  SUPPORT: "User asks a question, reports a problem, or needs help.",
  ESCALATE: "Sensitive dispute, accusation, legal/financial claim, or conflict needing a human.",
};

export async function requestJevDecision(
  config: JevConfig,
  state: Record<string, unknown>,
): Promise<StructuredDecision> {
  const body = {
    model: config.model ?? "typesafe/jev-1.13",
    state,
    questions: {
      category: {
        type: "choice",
        instructions: "Classify this community message. Pick exactly one.",
        criteria: CATEGORY_CRITERIA,
      },
      needs_human: {
        type: "noul",
        instructions: "Does this message need a human operator (uncertain, sensitive, or high-impact)?",
        criteria: {
          true: "Uncertain, sensitive, accusatory, financial, or high-impact.",
          false: "Routine and safe to handle automatically.",
        },
      },
      urgency: {
        type: "score",
        instructions: "How urgent is this message?",
        criteria: [
          "Routine: no time pressure.",
          "Notable: deserves attention today.",
          "Urgent: needs action within hours.",
          "Critical: immediate harm unfolding.",
        ],
      },
    },
  };

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl ?? "https://openrouter.ai"}/api/alpha/decisions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new JevError(error instanceof Error ? `network: ${error.message}` : "network error");
  }
  if (!res.ok) {
    let detail = `http ${res.status}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      if (err?.error?.message) detail += ` ${err.error.message}`;
    } catch {
      // keep status only
    }
    throw new JevError(detail);
  }
  const parsed = DecisionsResponse.safeParse(await res.json());
  if (!parsed.success) throw new JevError("unexpected response shape");
  return mapJevAnswers(parsed.data.answers);
}

/** Pure mapping from validated Jev answers to a structured decision.
 * Exported for offline tests (no network). */
export function mapJevAnswers(
  answers: z.infer<typeof DecisionsResponse>["answers"],
): StructuredDecision {
  const { category, needs_human, urgency } = answers;
  if (!(CATEGORIES as readonly string[]).includes(category.choice)) {
    throw new JevError(`unknown category: ${category.choice}`);
  }
  const probs = category.probabilities ?? {};
  const maxProb = Math.max(0, ...Object.values(probs));
  const confidence =
    typeof category.confidence === "number" ? category.confidence : maxProb;
  const spamProbability = probs.SPAM ?? 0;
  const scamProbability = probs.PHISHING ?? 0;
  const urgencyNorm = Math.min(1, Math.max(0, urgency.score / 3));
  const requiresHuman = needs_human.noul > 0.5 || confidence < 0.6;

  return {
    category: category.choice as (typeof CATEGORIES)[number],
    confidence,
    urgency: urgencyNorm,
    spamProbability,
    scamProbability,
    supportIntent: category.choice === "SUPPORT",
    ruleViolation: category.choice === "SPAM" || category.choice === "PHISHING",
    recommendedAction:
      category.choice === "SPAM" || category.choice === "PHISHING"
        ? "delete"
        : category.choice === "SUPPORT"
          ? "escalate"
          : category.choice === "ESCALATE"
            ? "escalate"
            : "none",
    reasoningSummary:
      `Jev choice=${category.choice} (confidence ${confidence.toFixed(2)}, ` +
      `spam ${spamProbability.toFixed(2)}, scam ${scamProbability.toFixed(2)}, ` +
      `urgency ${urgencyNorm.toFixed(2)}, needs_human ${needs_human.noul.toFixed(2)})`,
    requiresHuman,
    knowledgeRequired: category.choice === "SUPPORT",
  };
}
