import type { AgentContext, AgentDecision, PolicyDecision } from "./types";

// Policy v0 — deterministic and deliberately conservative. It is the ONLY
// authority that can authorize a Telegram mutation:
//
// - delete_message: ALLOW only for corroborated high-confidence SPAM/PHISHING
//   (model signal + independent deterministic signal), never for admins.
// - restrict_user / warn_user / send_reply: ALWAYS NEEDS_APPROVAL in v0.
//   Human review (Prompt 4+) tightens or relaxes this; nothing today can
//   bypass it because the executor enforces these verdicts.
// - create_alert / escalate: ALLOW (write-only observability, no Telegram
//   mutation, no user impact).

const DELETE_CONFIDENCE = 0.85;

export function evaluatePolicy(
  decision: AgentDecision,
  context: AgentContext,
): PolicyDecision[] {
  return decision.proposedActions.map((action) => {
    switch (action.tool) {
      case "create_alert":
      case "escalate":
        return {
          tool: action.tool,
          verdict: "ALLOW",
          reason: "observability-only; no Telegram mutation",
        };
      case "delete_message": {
        if (context.signals.isAdmin) {
          return {
            tool: action.tool,
            verdict: "DENY",
            reason: "sender is an administrator; never auto-delete admin messages",
          };
        }
        const severe =
          decision.classification === "SPAM" || decision.classification === "PHISHING";
        const corroborated =
          Boolean(context.signals.blockedDomain) ||
          context.signals.repeated ||
          context.signals.flooding;
        if (severe && decision.confidence >= DELETE_CONFIDENCE && corroborated) {
          return {
            tool: action.tool,
            verdict: "ALLOW",
            reason: `corroborated ${decision.classification} (confidence ${decision.confidence})`,
          };
        }
        return {
          tool: action.tool,
          verdict: "NEEDS_APPROVAL",
          reason: "uncorroborated or low-confidence deletion requires human review",
        };
      }
      case "restrict_user":
        return {
          tool: action.tool,
          verdict: "NEEDS_APPROVAL",
          reason: "v0: all restrictions require human approval",
        };
      case "warn_user":
        return {
          tool: action.tool,
          verdict: "NEEDS_APPROVAL",
          reason: "v0: all warnings require human approval",
        };
      case "send_reply":
        return {
          tool: action.tool,
          verdict: "NEEDS_APPROVAL",
          reason: "v0: outbound replies require approval until trusted answers land",
        };
    }
  });
}
