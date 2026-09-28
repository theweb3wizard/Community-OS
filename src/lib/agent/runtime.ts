import type { TelegramClient } from "@/lib/telegram/client";
import type { NormalizedEvent } from "@/lib/telegram/normalize";
import { loadContext } from "./context";
import { evaluatePolicy } from "./policy";
import {
  type DecisionProvider,
  DeterministicTestProvider,
  validateDecision,
} from "./provider";
import { drizzleStore, type AgentStore } from "./store";
import { executeTool } from "./tools";
import type { ActionResult, CycleResult } from "./types";

export interface RunCycleOptions {
  provider?: DecisionProvider;
  client?: TelegramClient;
  store?: AgentStore;
}

async function safeLog(
  store: AgentStore,
  row: { communityId: string | null; event: string; detail: Record<string, unknown> },
): Promise<void> {
  try {
    await store.log(row);
  } catch {
    // Logging must never crash the cycle or mask the original outcome.
  }
}

/** One full OBSERVE→…→LOG→ESCALATE pass for a normalized event. */
export async function runAgentCycle(
  event: NormalizedEvent,
  opts: RunCycleOptions = {},
): Promise<CycleResult> {
  const provider = opts.provider ?? new DeterministicTestProvider();
  const store = opts.store ?? drizzleStore;

  // Context loading is the first fallible stage (includes DB access).
  let context;
  try {
    context = await loadContext(event, store);
  } catch (error) {
    return {
      cycleId: "unknown",
      status: "failed",
      error: error instanceof Error ? error.message : "context_failed",
    };
  }
  const { cycleId } = context;

  // The Prompt-2 pipeline owns commands, callbacks, and membership. The
  // runtime only reasons over conversation messages.
  if (event.kind !== "message" && event.kind !== "edited_message") {
    return { cycleId, status: "skipped", reason: `kind_${event.kind}` };
  }
  if (context.signals.isControlCommand) {
    await safeLog(store, {
      communityId: context.community.id,
      event: "agent.cycle_skipped",
      detail: { cycleId, reason: "control_command" },
    });
    return { cycleId, status: "skipped", reason: "control_command" };
  }

  // Decision (untrusted output — validated before use).
  let raw: unknown;
  try {
    raw = await provider.decide(context);
  } catch (error) {
    await safeLog(store, {
      communityId: context.community.id,
      event: "agent.cycle_failed",
      detail: { cycleId, stage: "decide", error: error instanceof Error ? error.message : "unknown" },
    });
    return {
      cycleId,
      status: "failed",
      error: error instanceof Error ? error.message : "decide_failed",
    };
  }
  const validated = validateDecision(raw);
  if (!validated.ok) {
    await safeLog(store, {
      communityId: context.community.id,
      event: "agent.cycle_rejected",
      detail: { cycleId, reason: validated.reason },
    });
    return { cycleId, status: "rejected", reason: validated.reason };
  }
  const decision = validated.decision;

  // Policy authorizes each proposed action independently.
  const policy = evaluatePolicy(decision, context);

  // Execute / queue / deny, recording every outcome.
  const results: ActionResult[] = [];
  for (let i = 0; i < decision.proposedActions.length; i++) {
    const action = decision.proposedActions[i];
    const verdict = policy[i].verdict;
    try {
      if (verdict === "DENY") {
        const id = await store.recordAction({
          communityId: context.community.id,
          tool: action.tool,
          status: "denied",
          detail: { cycleId, reason: policy[i].reason, classification: decision.classification },
        });
        results.push({ cycleId, tool: action.tool, status: "denied", detail: { actionId: id, reason: policy[i].reason } });
      } else if (verdict === "NEEDS_APPROVAL") {
        const approvalId = await store.recordApproval({
          communityId: context.community.id,
          kind: action.tool,
          title: `${decision.classification} → ${action.tool}`,
          detail: {
            cycleId,
            classification: decision.classification,
            confidence: decision.confidence,
            rationale: decision.rationale,
            tool: action.tool,
            args: action.args,
            policyReason: policy[i].reason,
            chatId: event.chatId,
            messageId: event.messageId ?? null,
            senderId: event.sender?.id ?? null,
          },
        });
        const id = await store.recordAction({
          communityId: context.community.id,
          tool: action.tool,
          status: "approval_pending",
          detail: { cycleId, approvalId, classification: decision.classification },
        });
        results.push({ cycleId, tool: action.tool, status: "approval_pending", detail: { actionId: id, approvalId } });
      } else {
        const outcome = await executeTool(action.tool, {
          cycleId,
          client: opts.client,
          store,
          context,
          decision,
          action,
        });
        const id = await store.recordAction({
          communityId: context.community.id,
          tool: action.tool,
          status: outcome.ok ? "executed" : "failed",
          detail: {
            cycleId,
            classification: decision.classification,
            ...(outcome.detail ?? {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          },
        });
        results.push({
          cycleId,
          tool: action.tool,
          status: outcome.ok ? "executed" : "failed",
          detail: { actionId: id, ...(outcome.detail ?? {}) },
          error: outcome.error,
          telegramMessageId: outcome.telegramMessageId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      try {
        const id = await store.recordAction({
          communityId: context.community.id,
          tool: action.tool,
          status: "failed",
          detail: { cycleId, error: message, classification: decision.classification },
        });
        results.push({ cycleId, tool: action.tool, status: "failed", error: message, detail: { actionId: id } });
      } catch {
        results.push({ cycleId, tool: action.tool, status: "failed", error: message });
      }
    }
  }

  await safeLog(store, {
    communityId: context.community.id,
    event: "agent.cycle_completed",
    detail: {
      cycleId,
      classification: decision.classification,
      confidence: decision.confidence,
      actions: results.map((r) => `${r.tool}:${r.status}`),
    },
  });
  return { cycleId, status: "completed", decision, policy, results };
}
