import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { activityLogs, agentActions, approvals, communitySettings } from "@/db/schema";
import type {
  ActionStatus,
  AgentContext,
  AgentDecision,
  ProposedAction,
  RiskLevel,
  ToolName,
} from "@/lib/agent/types";
import { executeTool } from "@/lib/agent/tools";
import { drizzleStore } from "@/lib/agent/store";
import type { NormalizedEvent } from "@/lib/telegram/normalize";
import { TelegramClient } from "@/lib/telegram/client";

// Approval lifecycle. Safety properties:
// - Callback payloads carry only an unguessable per-approval token
//   (`ap:<token>` / `rj:<token>`, well within Telegram's 64-byte
//   callback_data limit). Lookup is server-side; data is never trusted.
// - The acting admin's Telegram ID must equal the community's linked admin.
// - Execution happens AT MOST ONCE via an atomic single-statement claim
//   (UPDATE ... WHERE status='pending' ... RETURNING). neon-http offers no
//   interactive transactions, so idempotency is a constraint, not memory.

export type ApprovalChoice = "approve" | "reject";
export type ApprovalActor =
  | { kind: "telegram"; telegramUserId: string }
  | { kind: "dashboard"; email: string };

export type DecideOutcome =
  | "approved_executed"
  | "approved_failed"
  | "rejected"
  | "already_decided"
  | "unauthorized"
  | "expired"
  | "not_found";

export interface DecideResult {
  outcome: DecideOutcome;
  approvalId?: string;
  status?: string;
  error?: string;
  tool?: ToolName;
}

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

export function newCallbackToken(): string {
  return Array.from(randomBytes(16), (b) => TOKEN_ALPHABET[b % 64]).join("");
}

export interface ApprovalRequest {
  communityId: string;
  communityName: string;
  cycleId: string;
  decision: AgentDecision;
  action: ProposedAction;
  policyReason: string;
  risk: RiskLevel;
  chat: { id: string; title?: string; type: string };
  message: { id?: number; text?: string };
  member: { telegramId?: string; username?: string };
}

function dashboardUrl(): string | null {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  return /^https?:\/\//.test(base) ? `${base}/dashboard/approvals` : null;
}

/** Operator notification preferences; everything defaults to on. */
export async function notifyPreferences(
  communityId: string,
): Promise<{ approvals: boolean; failures: boolean }> {
  const rows = await db
    .select()
    .from(communitySettings)
    .where(eq(communitySettings.communityId, communityId))
    .limit(1);
  const s = rows[0];
  return {
    approvals: s?.notifyApprovals ?? true,
    failures: s?.notifyFailures ?? true,
  };
}

export async function requestApproval(
  input: ApprovalRequest,
  client?: TelegramClient,
): Promise<{ approvalId: string; token: string; dmSent: boolean; dmError?: string }> {
  const token = newCallbackToken();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  const [row] = await db
    .insert(approvals)
    .values({
      communityId: input.communityId,
      kind: input.action.tool,
      title: `${input.decision.classification} → ${input.action.tool}`,
      status: "pending",
      requestedBy: "agent-runtime",
      detail: {
        callbackToken: token,
        expiresAt,
        cycleId: input.cycleId,
        classification: input.decision.classification,
        confidence: input.decision.confidence,
        rationale: input.decision.rationale,
        tool: input.action.tool,
        args: input.action.args,
        policyReason: input.policyReason,
        risk: input.risk,
        chatId: input.chat.id,
        chatTitle: input.chat.title ?? null,
        chatType: input.chat.type,
        messageId: input.message.id ?? null,
        messageText: (input.message.text ?? "").slice(0, 500),
        senderId: input.member.telegramId ?? null,
        senderUsername: input.member.username ?? null,
      },
    })
    .returning({ id: approvals.id });

  let dmSent = false;
  let dmError: string | undefined;
  const prefs = await notifyPreferences(input.communityId).catch(() => ({
    approvals: true,
    failures: true,
  }));
  if (!prefs.approvals) {
    dmError = "notifications_disabled";
  } else if (client) {
    const adminId = await adminIdFor(input.communityId);
    if (adminId) {
      const dashUrl = dashboardUrl();
      try {
        await client.sendAdminNotification(
          adminId,
          `🚨 Approval needed: ${input.action.tool}`,
          [
            `Community: ${input.communityName}`,
            `User: ${input.member.username ? `@${input.member.username} ` : ""}(${input.member.telegramId ?? "?"})`,
            `Message: ${(input.message.text ?? "").slice(0, 200) || "(no text)"}`,
            `Proposed: ${input.action.tool} — ${input.policyReason}`,
            `Confidence: ${input.decision.confidence} · Risk: ${input.risk}`,
            `Reason: ${input.decision.rationale.slice(0, 200)}`,
          ].join("\n"),
          [
            { label: "✅ Approve", data: `ap:${token}` },
            { label: "❌ Reject", data: `rj:${token}` },
          ],
          dashUrl ? [{ label: "Open Dashboard", url: dashUrl }] : [],
        );
        dmSent = true;
      } catch (error) {
        dmError = error instanceof Error ? error.message : "dm_failed";
      }
    } else {
      dmError = "no_admin_linked";
    }
  } else {
    dmError = "no_telegram_client";
  }

  await db.insert(activityLogs).values({
    communityId: input.communityId,
    actorType: "agent",
    event: "approval.requested",
    detail: { approvalId: row.id, cycleId: input.cycleId, tool: input.action.tool, dmSent },
  });
  return { approvalId: row.id, token, dmSent, dmError };
}

type ApprovalRow = typeof approvals.$inferSelect;

async function loadApproval(byToken?: string, byId?: string): Promise<ApprovalRow | undefined> {
  if (byToken) {
    // drizzle's query builder maps columns; the token lives inside the
    // detail JSON, so the predicate is raw SQL but the row stays mapped.
    const rows = await db
      .select()
      .from(approvals)
      .where(sql`${approvals.detail}->>'callbackToken' = ${byToken}`)
      .limit(1);
    return rows[0];
  }
  if (byId) {
    const rows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, byId))
      .limit(1);
    return rows[0];
  }
  return undefined;
}

async function adminIdFor(communityId: string): Promise<string | null> {
  const rows = await db.execute(
    sql`select admin_telegram_user_id as "adminId" from telegram_connections where community_id = ${communityId} limit 1`,
  );
  return ((rows.rows[0] as { adminId?: string } | undefined)?.adminId ?? null) || null;
}

function executionContext(detail: Record<string, unknown>, communityId: string): {
  context: AgentContext;
  decision: AgentDecision;
  action: ProposedAction;
} {
  const chatId = String(detail.chatId ?? "0");
  const senderId = typeof detail.senderId === "string" ? detail.senderId : undefined;
  const event = {
    updateId: 0,
    kind: "message",
    chatId,
    chatType: "supergroup",
    sender: senderId ? { id: senderId, isBot: false } : undefined,
    messageId: typeof detail.messageId === "number" ? detail.messageId : undefined,
    text: typeof detail.messageText === "string" ? detail.messageText : undefined,
    raw: {},
  } as NormalizedEvent;
  const context: AgentContext = {
    cycleId: String(detail.cycleId ?? "approval"),
    community: { id: communityId, name: "", slug: "" },
    recentMessages: [],
    policies: [],
    signals: {
      isAdmin: false,
      isControlCommand: false,
      urls: [],
      repeated: false,
      flooding: false,
    },
    event,
  };
  const decision: AgentDecision = {
    classification: (detail.classification as AgentDecision["classification"]) ?? "ESCALATE",
    confidence: typeof detail.confidence === "number" ? detail.confidence : 0,
    rationale: typeof detail.rationale === "string" ? detail.rationale : "approval execution",
    proposedActions: [],
  };
  const action: ProposedAction = {
    tool: detail.tool as ToolName,
    args: (detail.args as Record<string, unknown>) ?? {},
  };
  return { context, decision, action };
}

export async function decideApproval(
  input: {
    byToken?: string;
    byId?: string;
    choice: ApprovalChoice;
    actor: ApprovalActor;
    client?: TelegramClient;
  },
): Promise<DecideResult> {
  const approval = await loadApproval(input.byToken, input.byId);
  if (!approval) return { outcome: "not_found" };
  const detail = (approval.detail ?? {}) as Record<string, unknown>;

  if (approval.status !== "pending") {
    return { outcome: "already_decided", approvalId: approval.id, status: approval.status };
  }
  if (typeof detail.expiresAt === "string" && Date.now() > Date.parse(detail.expiresAt)) {
    await db
      .update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")));
    return { outcome: "expired", approvalId: approval.id };
  }

  // Authenticate: Telegram actors must be the linked community admin.
  const actorLabel =
    input.actor.kind === "telegram"
      ? `telegram:${input.actor.telegramUserId}`
      : `dashboard:${input.actor.email}`;
  if (input.actor.kind === "telegram") {
    const adminId = await adminIdFor(approval.communityId);
    if (!adminId || adminId !== input.actor.telegramUserId) {
      await db.insert(activityLogs).values({
        communityId: approval.communityId,
        actorType: "system",
        event: "telegram.approval_unauthorized",
        detail: {
          approvalId: approval.id,
          telegramUserId: input.actor.telegramUserId,
          tool: approval.kind,
        },
      });
      return { outcome: "unauthorized", approvalId: approval.id };
    }
  }

  // Atomic claim: exactly one decider wins; duplicates see non-pending.
  const claimed = await db
    .update(approvals)
    .set({
      status: input.choice === "approve" ? "approved" : "rejected",
      decidedAt: new Date(),
    })
    .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
    .returning({ id: approvals.id, status: approvals.status });
  if (claimed.length === 0) {
    const current = await loadApproval(undefined, approval.id);
    return { outcome: "already_decided", approvalId: approval.id, status: current?.status };
  }

  const tool = approval.kind as ToolName;
  const tgRef = {
    telegramMessageId:
      typeof detail.messageId === "number" ? String(detail.messageId) : null,
    chatId: typeof detail.chatId === "string" ? detail.chatId : null,
  };
  if (input.choice === "reject") {
    await db.insert(agentActions).values({
      communityId: approval.communityId,
      kind: tool,
      status: "denied",
      detail: { approvalId: approval.id, decidedBy: actorLabel, reason: "rejected_by_operator", ...tgRef },
    });
    await db.insert(activityLogs).values({
      communityId: approval.communityId,
      actorType: "agent",
      event: "approval.decided",
      detail: { approvalId: approval.id, outcome: "rejected", decidedBy: actorLabel },
    });
    return { outcome: "rejected", approvalId: approval.id, tool };
  }

  // Approved: execute exactly once (we hold the claim).
  const exec = executionContext(detail, approval.communityId);
  try {
    const outcome = await executeTool(tool, {
      cycleId: exec.context.cycleId,
      client: input.client,
      store: drizzleStore,
      context: exec.context,
      decision: exec.decision,
      action: exec.action,
    });
    await db.insert(agentActions).values({
      communityId: approval.communityId,
      kind: tool,
      status: outcome.ok ? "executed" : "failed",
      detail: {
        approvalId: approval.id,
        decidedBy: actorLabel,
        ...tgRef,
        ...(outcome.detail ?? {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    });
    if (!outcome.ok) {
      await db
        .update(approvals)
        .set({ status: "failed", detail: { ...detail, error: outcome.error ?? "execution_failed" } })
        .where(eq(approvals.id, approval.id));
      await db.insert(activityLogs).values({
        communityId: approval.communityId,
        actorType: "agent",
        event: "approval.execution_failed",
        detail: { approvalId: approval.id, error: outcome.error ?? "execution_failed" },
      });
      // Notify the admin the approval did NOT take effect.
      await notifyAdmin(approval.communityId, input.client, `⚠️ Approved action FAILED: ${tool} — ${outcome.error ?? "unknown error"}. Nothing was applied; check the dashboard.`);
      return { outcome: "approved_failed", approvalId: approval.id, tool, error: outcome.error };
    }
    await db.insert(activityLogs).values({
      communityId: approval.communityId,
      actorType: "agent",
      event: "approval.decided",
      detail: {
        approvalId: approval.id,
        outcome: "approved_executed",
        decidedBy: actorLabel,
        telegramMessageId: outcome.telegramMessageId ?? null,
      },
    });
    return { outcome: "approved_executed", approvalId: approval.id, tool };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    await db
      .update(approvals)
      .set({ status: "failed", detail: { ...detail, error: message } })
      .where(eq(approvals.id, approval.id));
    await db.insert(agentActions).values({
      communityId: approval.communityId,
      kind: tool,
      status: "failed" as ActionStatus,
      detail: { approvalId: approval.id, decidedBy: actorLabel, error: message, ...tgRef },
    });
    await db.insert(activityLogs).values({
      communityId: approval.communityId,
      actorType: "agent",
      event: "approval.execution_failed",
      detail: { approvalId: approval.id, error: message },
    });
    await notifyAdmin(approval.communityId, input.client, `⚠️ Approved action FAILED: ${tool} — ${message}. Nothing was applied; check the dashboard.`);
    return { outcome: "approved_failed", approvalId: approval.id, tool, error: message };
  }
}

async function notifyAdmin(
  communityId: string,
  client: TelegramClient | undefined,
  text: string,
): Promise<void> {
  if (!client) return;
  try {
    const prefs = await notifyPreferences(communityId);
    if (!prefs.failures) return;
    const adminId = await adminIdFor(communityId);
    if (adminId) await client.sendMessage(Number(adminId), text);
  } catch {
    // Best effort: the failure is already persisted + logged.
  }
}
