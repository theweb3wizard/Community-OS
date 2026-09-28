import { z } from "zod";

import type { Classification } from "@/lib/agent/types";

// Validated structured output shared by both decision providers. Raw model
// output (Jev answers or Gemini JSON) is converted into this shape and
// validated here — tools can only ever see what survives this gate.

export const StructuredDecisionSchema = z.object({
  category: z.enum(["NORMAL", "SPAM", "PHISHING", "SUPPORT", "ESCALATE"]),
  confidence: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
  spamProbability: z.number().min(0).max(1),
  scamProbability: z.number().min(0).max(1),
  supportIntent: z.boolean(),
  ruleViolation: z.boolean(),
  recommendedAction: z.enum([
    "none",
    "delete",
    "restrict",
    "warn",
    "reply",
    "escalate",
    "alert",
  ]),
  reasoningSummary: z.string().min(1).max(1000),
  requiresHuman: z.boolean(),
  knowledgeRequired: z.boolean(),
});

export type StructuredDecision = z.infer<typeof StructuredDecisionSchema>;

/** Plain JSON Schema (Gemini responseJsonSchema). Descriptions kept short —
 * oversized descriptions cause 400s on the API. */
export const STRUCTURED_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: ["NORMAL", "SPAM", "PHISHING", "SUPPORT", "ESCALATE"],
      description: "Single best-fit message category.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "Certainty in category." },
    urgency: { type: "number", minimum: 0, maximum: 1, description: "0 routine, 1 critical." },
    spamProbability: { type: "number", minimum: 0, maximum: 1, description: "Bulk/unsolicited likelihood." },
    scamProbability: { type: "number", minimum: 0, maximum: 1, description: "Phishing/fraud likelihood." },
    supportIntent: { type: "boolean", description: "User asks for help or info." },
    ruleViolation: { type: "boolean", description: "Likely breaks community rules." },
    recommendedAction: {
      type: "string",
      enum: ["none", "delete", "restrict", "warn", "reply", "escalate", "alert"],
      description: "Minimal next step. restrict/warn need human approval.",
    },
    reasoningSummary: { type: "string", description: "One or two sentences." },
    requiresHuman: { type: "boolean", description: "True when uncertain or sensitive." },
    knowledgeRequired: { type: "boolean", description: "True to answer from docs." },
  },
  required: [
    "category",
    "confidence",
    "urgency",
    "spamProbability",
    "scamProbability",
    "supportIntent",
    "ruleViolation",
    "recommendedAction",
    "reasoningSummary",
    "requiresHuman",
    "knowledgeRequired",
  ],
  additionalProperties: false,
};

export function validateStructuredDecision(input: unknown):
  | { ok: true; decision: StructuredDecision }
  | { ok: false; reason: string } {
  const parsed = StructuredDecisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid_structured_decision" };
  return { ok: true, decision: parsed.data };
}

export function toClassification(d: StructuredDecision): Classification {
  return d.category;
}
