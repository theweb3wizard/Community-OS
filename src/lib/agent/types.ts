import type { NormalizedEvent } from "@/lib/telegram/normalize";

// Agent runtime vocabulary (Prompt 3). The agent is the orchestration layer:
// providers RECOMMEND (structured data), the policy engine AUTHORIZES, and
// only registered tools can ACT. Model output never carries authority and
// never supplies execution targets — targets always come from the event.

export type Classification = "NORMAL" | "SPAM" | "PHISHING" | "SUPPORT" | "ESCALATE";

export type ToolName =
  | "send_reply"
  | "delete_message"
  | "warn_user"
  | "restrict_user"
  | "create_alert"
  | "escalate";

export const REGISTERED_TOOLS: readonly ToolName[] = [
  "send_reply",
  "delete_message",
  "warn_user",
  "restrict_user",
  "create_alert",
  "escalate",
] as const;

/** A single tool invocation proposed by a decision provider. */
export interface ProposedAction {
  tool: ToolName;
  /** Advisory parameters only. Execution targets (chat/message/user) are
   * always re-derived from the triggering event — never trusted from here. */
  args: Record<string, unknown>;
  rationale?: string;
}

export interface AgentDecision {
  classification: Classification;
  /** 0..1 */
  confidence: number;
  rationale: string;
  proposedActions: ProposedAction[];
}

export type PolicyVerdict = "ALLOW" | "NEEDS_APPROVAL" | "DENY";

export interface PolicyDecision {
  tool: ToolName;
  verdict: PolicyVerdict;
  reason: string;
}

export type ActionStatus =
  | "executed"
  | "failed"
  | "approval_pending"
  | "denied"
  | "skipped";

export interface ActionResult {
  cycleId: string;
  tool: ToolName;
  status: ActionStatus;
  detail?: Record<string, unknown>;
  error?: string;
  telegramMessageId?: number;
}

export interface DeterministicSignals {
  isAdmin: boolean;
  isControlCommand: boolean;
  urls: string[];
  blockedDomain?: string;
  allowlistedDomain?: string;
  repeated: boolean;
  flooding: boolean;
}

export interface AgentContext {
  cycleId: string;
  community: { id: string; name: string; slug: string };
  member?: { id: string; telegramUserId: string; username: string | null; role: string };
  message?: {
    id: string;
    telegramMessageId: string | null;
    text: string | null;
    kind: string;
    sentAt: Date | null;
  };
  /** Bounded: at most 10, text truncated. Never a full history dump. */
  recentMessages: Array<{
    telegramMessageId: string | null;
    senderTelegramId: string | null;
    text: string | null;
    sentAt: Date | null;
  }>;
  policies: Array<{ id: string; name: string; rules: Record<string, unknown> }>;
  signals: DeterministicSignals;
  event: NormalizedEvent;
}

export type CycleStatus = "completed" | "rejected" | "failed" | "skipped";

export interface CycleResult {
  cycleId: string;
  status: CycleStatus;
  decision?: AgentDecision;
  policy?: PolicyDecision[];
  results?: ActionResult[];
  reason?: string;
  error?: string;
}
