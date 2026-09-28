import type {
  AgentContext,
  AgentDecision,
  PolicyDecision,
  ProposedAction,
  RiskLevel,
  ToolName,
} from "./types";

// Policy engine v1 — deterministic. The model proposes; THIS module alone
// decides what may happen. Verdicts:
//
//   AUTO_EXECUTE  — safe, corroborated, reversible-ish: run now.
//   NEEDS_APPROVAL — consequential: queue + notify admin, execute on approval.
//   ESCALATE      — human-only territory: alert operators, never auto-run.
//   IGNORE        — no actionable signal: log and drop.
//
// Idempotency note: neon-http has no interactive transactions, so the
// approval lifecycle below (service.ts) claims work with a single atomic
// UPDATE ... WHERE status='pending' ... RETURNING instead of transactions.

const DELETE_CONFIDENCE = 0.85;

// Topics that always require a human, no matter the classification.
const HUMAN_ONLY_PATTERNS: RegExp[] = [
  /\bcontract\s+(address|update|change|migration)\b/i,
  /\btreasury\b/i,
  /\bgovernance\b/i,
  /\bvote\b.{0,20}\b(proposal|funds|treasury)\b/i,
  /\bairdrop\s+claim\b/i,
  /\bseed\s+phrase\b/i,
  /\bprivate\s+key\b/i,
  /\bofficial\s+announcement\b/i,
  /\bscam\s+accusation\b/i,
  /\b(accuse|accusing)\b.{0,30}\b(scam|fraud|rug)\b/i,
];

export interface CommunityPolicyOptions {
  mode: "standard" | "strict";
  autoDeleteSpam: boolean;
  requireApproval: ToolName[];
  humanOnlyPatterns: string[];
}

function readCommunityOptions(context: AgentContext): CommunityPolicyOptions {
  const opts: CommunityPolicyOptions = {
    mode: "standard",
    autoDeleteSpam: true,
    requireApproval: [],
    humanOnlyPatterns: [],
  };
  for (const p of context.policies) {
    const r = p.rules as Record<string, unknown>;
    if (r.mode === "strict" || r.mode === "standard") opts.mode = r.mode;
    if (typeof r.autoDeleteSpam === "boolean") opts.autoDeleteSpam = r.autoDeleteSpam;
    if (Array.isArray(r.requireApproval)) {
      for (const t of r.requireApproval) {
        if (typeof t === "string") opts.requireApproval.push(t as ToolName);
      }
    }
    if (Array.isArray(r.humanOnlyPatterns)) {
      for (const pattern of r.humanOnlyPatterns) {
        if (typeof pattern === "string" && pattern.length < 200) {
          opts.humanOnlyPatterns.push(pattern);
        }
      }
    }
  }
  return opts;
}

function humanOnlyTopic(text: string, extraPatterns: string[]): string | null {
  for (const re of HUMAN_ONLY_PATTERNS) {
    if (re.test(text)) return `human-only topic (${re.source.slice(0, 40)})`;
  }
  for (const pattern of extraPatterns) {
    try {
      if (new RegExp(pattern, "i").test(text)) return `human-only topic (community pattern)`;
    } catch {
      // Invalid community regex — ignore, never crash policy on config.
    }
  }
  return null;
}

function assessRisk(
  decision: AgentDecision,
  context: AgentContext,
  tool: ToolName,
  humanOnly: string | null,
): { risk: RiskLevel; riskFactors: string[] } {
  const factors: string[] = [];
  if (decision.classification === "PHISHING") factors.push("phishing");
  if (decision.classification === "SPAM") factors.push("spam");
  if (decision.confidence < 0.7) factors.push("low-confidence");
  if (context.signals.isAdmin) factors.push("admin-involved");
  if (humanOnly) factors.push(humanOnly);
  if (tool === "restrict_user") factors.push("restriction");
  if (tool === "send_reply" || tool === "warn_user") factors.push("outbound-message");
  let risk: RiskLevel = "low";
  if (
    humanOnly ||
    (decision.classification === "PHISHING" && decision.confidence >= 0.9) ||
    context.signals.isAdmin
  ) {
    risk = "high";
  } else if (
    decision.classification === "SPAM" ||
    decision.classification === "PHISHING" ||
    decision.confidence < 0.7 ||
    tool === "restrict_user"
  ) {
    risk = "medium";
  }
  return { risk, riskFactors: factors };
}

function decideOne(
  action: ProposedAction,
  decision: AgentDecision,
  context: AgentContext,
  opts: CommunityPolicyOptions,
): PolicyDecision {
  const text = context.message?.text ?? context.event.text ?? "";
  const hotTopic = humanOnlyTopic(text, opts.humanOnlyPatterns);
  const { risk, riskFactors } = assessRisk(decision, context, action.tool, hotTopic);
  const base = { tool: action.tool, risk, riskFactors };

  // Observability never touches Telegram or users.
  if (action.tool === "create_alert" || action.tool === "escalate") {
    return { ...base, verdict: "AUTO_EXECUTE", reason: "observability-only; no Telegram mutation" };
  }

  // Human-only territory and model-flagged sensitivity escalate, never queue.
  if (hotTopic) {
    return { ...base, verdict: "ESCALATE", reason: hotTopic };
  }
  if (decision.requiresHuman) {
    return { ...base, verdict: "ESCALATE", reason: "decision requires a human operator" };
  }

  // Community overrides.
  if (opts.requireApproval.includes(action.tool)) {
    return { ...base, verdict: "NEEDS_APPROVAL", reason: "community policy requires approval" };
  }
  if (opts.mode === "strict") {
    return { ...base, verdict: "NEEDS_APPROVAL", reason: "community runs in strict mode" };
  }

  if (action.tool === "delete_message") {
    if (context.signals.isAdmin) {
      return { ...base, verdict: "IGNORE", reason: "sender is an administrator; never auto-delete admin messages" };
    }
    const severe =
      decision.classification === "SPAM" || decision.classification === "PHISHING";
    const corroborated =
      Boolean(context.signals.blockedDomain) ||
      context.signals.repeated ||
      context.signals.flooding;
    if (opts.autoDeleteSpam && severe && decision.confidence >= DELETE_CONFIDENCE && corroborated) {
      return {
        ...base,
        verdict: "AUTO_EXECUTE",
        reason: `corroborated ${decision.classification} (confidence ${decision.confidence})`,
      };
    }
    if (decision.classification === "NORMAL") {
      return { ...base, verdict: "IGNORE", reason: "no actionable signal for deletion" };
    }
    return {
      ...base,
      verdict: "NEEDS_APPROVAL",
      reason: "uncorroborated or low-confidence deletion requires human review",
    };
  }

  if (action.tool === "restrict_user") {
    return { ...base, verdict: "NEEDS_APPROVAL", reason: "restrictions require human approval" };
  }
  if (action.tool === "warn_user") {
    return { ...base, verdict: "NEEDS_APPROVAL", reason: "warnings require human approval" };
  }
  // send_reply
  return {
    ...base,
    verdict: "NEEDS_APPROVAL",
    reason: "outbound replies require approval until trusted answers land",
  };
}

/** Authorize every proposed action. Pure function of (decision, context). */
export function evaluatePolicy(
  decision: AgentDecision,
  context: AgentContext,
): PolicyDecision[] {
  const opts = readCommunityOptions(context);
  return decision.proposedActions.map((action) =>
    decideOne(action, decision, context, opts),
  );
}
