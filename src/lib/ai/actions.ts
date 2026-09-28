import type { AgentDecision, ProposedAction } from "@/lib/agent/types";
import type { StructuredDecision } from "./structured";

// Single mapping from a validated structured decision to runtime actions,
// shared by the Jev and Gemini providers (and the deterministic test
// provider's shapes). Model output can only ever select among these
// pre-defined expansions — it cannot invent tools or targets.

export function decisionToActions(d: StructuredDecision): ProposedAction[] {
  switch (d.recommendedAction) {
    case "delete":
      return [{ tool: "delete_message", args: {}, rationale: d.reasoningSummary }];
    case "restrict":
      return [{ tool: "restrict_user", args: {}, rationale: d.reasoningSummary }];
    case "warn":
      return [{ tool: "warn_user", args: {}, rationale: d.reasoningSummary }];
    case "reply":
      // Replies carry model-written text, so they always route through human
      // approval under policy v0; the text travels in args for review.
      return [{ tool: "send_reply", args: {}, rationale: d.reasoningSummary }];
    case "escalate":
      return [
        {
          tool: "escalate",
          args: { severity: d.urgency >= 0.5 ? "high" : "normal", note: d.reasoningSummary },
          rationale: d.reasoningSummary,
        },
      ];
    case "alert":
      return [
        {
          tool: "create_alert",
          args: { severity: d.urgency >= 0.5 ? "high" : "normal", title: `Signal: ${d.category}` },
          rationale: d.reasoningSummary,
        },
      ];
    case "none":
      return [];
  }
}

export function toAgentDecision(d: StructuredDecision, provider: string): AgentDecision {
  return {
    classification: d.category,
    confidence: d.confidence,
    rationale: `[${provider}] ${d.reasoningSummary}`,
    proposedActions: decisionToActions(d),
    requiresHuman: d.requiresHuman,
  };
}
