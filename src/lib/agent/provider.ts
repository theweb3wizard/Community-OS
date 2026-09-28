import { z } from "zod";

import type {
  AgentContext,
  AgentDecision,
  Classification,
  ProposedAction,
  ToolName,
} from "./types";
import { REGISTERED_TOOLS } from "./types";

export interface DecisionProvider {
  readonly name: string;
  decide(context: AgentContext): Promise<AgentDecision>;
}

// Runtime-side validation: provider output is untrusted input (a future model
// WILL produce malformed JSON). Unknown tools are rejected here, before the
// policy stage — the registry can never see them.
const ProposedActionSchema = z.object({
  tool: z.enum(REGISTERED_TOOLS as unknown as [ToolName, ...ToolName[]]),
  args: z.record(z.string(), z.unknown()).default({}),
  rationale: z.string().optional(),
});

const DecisionSchema = z.object({
  classification: z.enum(["NORMAL", "SPAM", "PHISHING", "SUPPORT", "ESCALATE"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
  proposedActions: z.array(ProposedActionSchema).max(5),
  requiresHuman: z.boolean().optional(),
});

export type DecisionValidation =
  | { ok: true; decision: AgentDecision }
  | { ok: false; reason: string };

export function validateDecision(input: unknown): DecisionValidation {
  const parsed = DecisionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "malformed_decision" };
  }
  return {
    ok: true,
    decision: {
      ...parsed.data,
      proposedActions: parsed.data.proposedActions.map((a) => ({
        tool: a.tool,
        args: a.args as Record<string, unknown>,
        rationale: a.rationale,
      })),
      requiresHuman: parsed.data.requiresHuman,
    },
  };
}

// Deterministic stand-in for the future Jev/Gemini provider. Scenario is
// driven by explicit test markers in the message text — never by ambiguous
// heuristics — so every runtime path is reproducible without a model.
const MARKERS: Array<{
  marker: string;
  classification: Classification;
  confidence: number;
  actions: ProposedAction[];
  rationale: string;
}> = [
  {
    marker: "[phish-test]",
    classification: "PHISHING",
    confidence: 0.95,
    rationale: "test marker: impersonation pattern with suspicious link",
    actions: [
      { tool: "delete_message", args: {}, rationale: "remove phishing lure" },
      { tool: "restrict_user", args: {}, rationale: "contain spreader pending review" },
      {
        tool: "create_alert",
        args: { severity: "high", title: "Suspected phishing" },
        rationale: "notify operators",
      },
    ],
  },
  {
    marker: "[spam-test]",
    classification: "SPAM",
    confidence: 0.95,
    rationale: "test marker: unsolicited bulk content",
    actions: [{ tool: "delete_message", args: {}, rationale: "remove spam" }],
  },
  {
    marker: "[support-test]",
    classification: "SUPPORT",
    confidence: 0.8,
    rationale: "test marker: user needs help",
    actions: [
      {
        tool: "escalate",
        args: { severity: "normal", note: "support request triage" },
        rationale: "route to support queue",
      },
    ],
  },
  {
    marker: "[escalate-test]",
    classification: "ESCALATE",
    confidence: 0.9,
    rationale: "test marker: sensitive situation for humans",
    actions: [
      {
        tool: "escalate",
        args: { severity: "high", note: "operator review required" },
        rationale: "human-only situation",
      },
    ],
  },
];

export class DeterministicTestProvider implements DecisionProvider {
  readonly name = "deterministic-test";
  async decide(context: AgentContext): Promise<AgentDecision> {
    const text = (context.message?.text ?? context.event.text ?? "").toLowerCase();
    for (const m of MARKERS) {
      if (text.includes(m.marker)) {
        return {
          classification: m.classification,
          confidence: m.confidence,
          rationale: m.rationale,
          proposedActions: m.actions,
        };
      }
    }
    return {
      classification: "NORMAL",
      confidence: 0.99,
      rationale: "no test marker matched; treated as ordinary conversation",
      proposedActions: [],
    };
  }
}
