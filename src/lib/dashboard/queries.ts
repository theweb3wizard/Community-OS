import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  activityLogs,
  agentActions,
  alerts,
  approvals,
  communities,
  members,
  messages,
  supportIssues,
} from "@/db/schema";

// Read models for the operator dashboard. Every number shown comes from
// these queries — no fabricated metrics anywhere.

export interface DashboardStats {
  messages: number;
  members: number;
  moderationActions: number;
  supportOpen: number;
  supportResolved: number;
  approvalsPending: number;
  alertsOpen: number;
}

export async function getDashboardStats(communityId: string): Promise<DashboardStats> {
  const [[m], [mem], [mod], [open], [resolved], [pending], [openAlerts]] =
    await Promise.all([
      db.select({ n: count() }).from(messages).where(eq(messages.communityId, communityId)),
      db.select({ n: count() }).from(members).where(eq(members.communityId, communityId)),
      db
        .select({ n: count() })
        .from(agentActions)
        .where(
          and(
            eq(agentActions.communityId, communityId),
            sql`${agentActions.kind} in ('delete_message','restrict_user','warn_user')`,
          ),
        ),
      db
        .select({ n: count() })
        .from(supportIssues)
        .where(and(eq(supportIssues.communityId, communityId), eq(supportIssues.status, "open"))),
      db
        .select({ n: count() })
        .from(supportIssues)
        .where(
          and(
            eq(supportIssues.communityId, communityId),
            or(eq(supportIssues.status, "resolved"), eq(supportIssues.status, "closed")),
          ),
        ),
      db
        .select({ n: count() })
        .from(approvals)
        .where(and(eq(approvals.communityId, communityId), eq(approvals.status, "pending"))),
      db
        .select({ n: count() })
        .from(alerts)
        .where(and(eq(alerts.communityId, communityId), eq(alerts.status, "open"))),
    ]);
  return {
    messages: m.n,
    members: mem.n,
    moderationActions: mod.n,
    supportOpen: open.n,
    supportResolved: resolved.n,
    approvalsPending: pending.n,
    alertsOpen: openAlerts.n,
  };
}

export interface InboxItem {
  id: string;
  bucket: "urgent" | "needs_review" | "support" | "community_issue" | "resolved";
  title: string;
  subtitle: string;
  href: string;
  time: Date;
}

export async function getInboxItems(communityId: string): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  const openAlerts = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.communityId, communityId), eq(alerts.status, "open")))
    .orderBy(desc(alerts.createdAt))
    .limit(10);
  for (const a of openAlerts) {
    items.push({
      id: `alert:${a.id}`,
      bucket: a.severity === "high" || a.severity === "critical" ? "urgent" : "community_issue",
      title: a.title,
      subtitle: `Alert · ${a.severity} · ${a.createdAt.toISOString().slice(0, 16).replace("T", " ")}`,
      href: "/dashboard/activity",
      time: a.createdAt,
    });
  }
  const pendingApprovals = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.communityId, communityId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt))
    .limit(10);
  for (const a of pendingApprovals) {
    items.push({
      id: `approval:${a.id}`,
      bucket: "needs_review",
      title: a.title,
      subtitle: `Approval · ${a.kind} · awaiting decision`,
      href: "/dashboard/approvals",
      time: a.createdAt,
    });
  }
  const openSupport = await db
    .select()
    .from(supportIssues)
    .where(and(eq(supportIssues.communityId, communityId), eq(supportIssues.status, "open")))
    .orderBy(desc(supportIssues.createdAt))
    .limit(10);
  for (const s of openSupport) {
    items.push({
      id: `support:${s.id}`,
      bucket: "support",
      title: s.title,
      subtitle: `Support · ${s.priority} priority`,
      href: "/dashboard/support",
      time: s.createdAt,
    });
  }
  const badActions = await db
    .select()
    .from(agentActions)
    .where(
      and(
        eq(agentActions.communityId, communityId),
        or(
          eq(agentActions.status, "failed"),
          eq(agentActions.kind, "restrict_user"),
          eq(agentActions.kind, "warn_user"),
        ),
      ),
    )
    .orderBy(desc(agentActions.createdAt))
    .limit(10);
  for (const a of badActions) {
    items.push({
      id: `action:${a.id}`,
      bucket: "community_issue",
      title: `${a.kind} — ${a.status}`,
      subtitle: `Agent action · ${a.createdAt.toISOString().slice(0, 16).replace("T", " ")}`,
      href: "/dashboard/moderation",
      time: a.createdAt,
    });
  }
  const resolvedSupport = await db
    .select()
    .from(supportIssues)
    .where(
      and(
        eq(supportIssues.communityId, communityId),
        or(eq(supportIssues.status, "resolved"), eq(supportIssues.status, "closed")),
      ),
    )
    .orderBy(desc(supportIssues.updatedAt))
    .limit(10);
  for (const s of resolvedSupport) {
    items.push({
      id: `resolved:${s.id}`,
      bucket: "resolved",
      title: s.title,
      subtitle: `Resolved · ${s.status}`,
      href: "/dashboard/support",
      time: s.updatedAt,
    });
  }
  return items.sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 40);
}

export interface ModerationRow {
  id: string;
  kind: string;
  status: string;
  createdAt: Date;
  classification: string | null;
  reason: string | null;
  telegramMessageId: string | null;
  messageDbId: string | null;
  messageText: string | null;
  senderUsername: string | null;
  senderTelegramId: string | null;
  approvalId: string | null;
}

export async function getModerationRows(
  communityId: string,
  limit = 50,
): Promise<ModerationRow[]> {
  const actions = await db
    .select()
    .from(agentActions)
    .where(
      and(
        eq(agentActions.communityId, communityId),
        sql`${agentActions.kind} in ('delete_message','restrict_user','warn_user')`,
      ),
    )
    .orderBy(desc(agentActions.createdAt))
    .limit(limit);
  const tgIds = [
    ...new Set(
      actions
        .map((a) => ((a.detail ?? {}) as Record<string, unknown>).telegramMessageId)
        .filter((v): v is string => typeof v === "string"),
    ),
  ];
  const msgMap = new Map<
    string,
    { id: string; text: string | null; username: string | null; tgId: string | null }
  >();
  for (const tgId of tgIds.slice(0, 100)) {
    const rows = await db
      .select({
        id: messages.id,
        text: messages.text,
        username: members.username,
        tgId: members.telegramUserId,
      })
      .from(messages)
      .leftJoin(members, eq(messages.memberId, members.id))
      .where(and(eq(messages.communityId, communityId), eq(messages.telegramMessageId, tgId)))
      .limit(1);
    if (rows[0]) msgMap.set(tgId, rows[0]);
  }
  return actions.map((a) => {
    const d = (a.detail ?? {}) as Record<string, unknown>;
    const tgId = typeof d.telegramMessageId === "string" ? d.telegramMessageId : null;
    const msg = tgId ? msgMap.get(tgId) : undefined;
    return {
      id: a.id,
      kind: a.kind,
      status: a.status,
      createdAt: a.createdAt,
      classification: typeof d.classification === "string" ? d.classification : null,
      reason:
        typeof d.reason === "string"
          ? d.reason
          : typeof d.error === "string"
            ? d.error
            : null,
      telegramMessageId: tgId,
      messageDbId: msg?.id ?? null,
      messageText: msg?.text ?? (typeof d.messageText === "string" ? d.messageText : null),
      senderUsername: msg?.username ?? (typeof d.senderUsername === "string" ? d.senderUsername : null),
      senderTelegramId: msg?.tgId ?? (typeof d.senderId === "string" ? d.senderId : null),
      approvalId: typeof d.approvalId === "string" ? d.approvalId : null,
    };
  });
}

export interface MessageContext {
  message: typeof messages.$inferSelect;
  member: typeof members.$inferSelect | null;
  community: typeof communities.$inferSelect | null;
  actions: Array<typeof agentActions.$inferSelect>;
  approvalsList: Array<typeof approvals.$inferSelect>;
}

export async function getMessageContext(messageId: string): Promise<MessageContext | null> {
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  const message = rows[0];
  if (!message) return null;
  const [memberRows, communityRows] = await Promise.all([
    message.memberId
      ? db.select().from(members).where(eq(members.id, message.memberId)).limit(1)
      : Promise.resolve([]),
    message.communityId
      ? db.select().from(communities).where(eq(communities.id, message.communityId)).limit(1)
      : Promise.resolve([]),
  ]);
  const actions =
    message.telegramMessageId && message.communityId
      ? await db
          .select()
          .from(agentActions)
          .where(
            and(
              eq(agentActions.communityId, message.communityId),
              sql`${agentActions.detail}->>'telegramMessageId' = ${message.telegramMessageId}`,
            ),
          )
          .orderBy(desc(agentActions.createdAt))
          .limit(20)
      : [];
  const approvalsList =
    message.telegramMessageId !== null && message.communityId
      ? await db
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.communityId, message.communityId),
              sql`${approvals.detail}->>'telegramMessageId' = ${message.telegramMessageId} or (${approvals.detail}->>'messageId')::text = ${message.telegramMessageId}`,
            ),
          )
          .orderBy(desc(approvals.createdAt))
          .limit(20)
      : [];
  return {
    message,
    member: memberRows[0] ?? null,
    community: communityRows[0] ?? null,
    actions,
    approvalsList,
  };
}

export interface ActivityFilter {
  q?: string;
  actor?: string;
  event?: string;
  limit?: number;
}

export async function getActivityRows(
  communityId: string,
  filter: ActivityFilter = {},
): Promise<Array<typeof activityLogs.$inferSelect>> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const conditions = [eq(activityLogs.communityId, communityId)];
  if (filter.actor) conditions.push(eq(activityLogs.actorType, filter.actor));
  if (filter.event) conditions.push(ilike(activityLogs.event, `%${filter.event}%`));
  if (filter.q) conditions.push(ilike(activityLogs.event, `%${filter.q}%`));
  return db
    .select()
    .from(activityLogs)
    .where(and(...conditions))
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit);
}

export async function recentActivity(
  communityId: string,
  limit = 10,
): Promise<Array<typeof activityLogs.$inferSelect>> {
  return getActivityRows(communityId, { limit });
}
