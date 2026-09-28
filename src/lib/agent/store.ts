import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  activityLogs,
  agentActions,
  alerts,
  approvals,
  communities,
  members,
  messages,
  policies,
  telegramConnections,
} from "@/db/schema";
import type { ActionStatus } from "./types";

// Persistence boundary for the runtime. A narrow interface so tests can
// inject a throwing store to prove DB-failure behavior (and so a future
// transactional store can slot in — neon-http is non-interactive, so the
// runtime is built on idempotent single writes, never multi-statement
// transactions).

export interface PolicyRules {
  blockedDomains?: string[];
  allowlistedDomains?: string[];
  floodThreshold?: number;
  repeatThreshold?: number;
}

export interface AgentStore {
  findCommunityByChat(chatId: string): Promise<{ id: string; name: string; slug: string } | undefined>;
  findMember(communityId: string, telegramUserId: string): Promise<{ id: string; telegramUserId: string; username: string | null; role: string } | undefined>;
  findMessage(communityId: string, telegramMessageId: string): Promise<{ id: string; telegramMessageId: string | null; text: string | null; kind: string; sentAt: Date | null; memberId: string | null } | undefined>;
  recentMessages(communityId: string, limit: number): Promise<Array<{ telegramMessageId: string | null; senderTelegramId: string | null; text: string | null; sentAt: Date | null }>>;
  activePolicies(communityId: string): Promise<Array<{ id: string; name: string; rules: Record<string, unknown> }>>;
  adminTelegramId(communityId: string): Promise<string | null>;
  recordAction(row: { communityId: string; tool: string; status: ActionStatus; detail: Record<string, unknown> }): Promise<string>;
  recordAlert(row: { communityId: string; severity: string; title: string; body: string | null }): Promise<string>;
  recordApproval(row: { communityId: string; kind: string; title: string; detail: Record<string, unknown> }): Promise<string>;
  log(row: { communityId: string | null; event: string; detail: Record<string, unknown> }): Promise<void>;
}

export const drizzleStore: AgentStore = {
  async findCommunityByChat(chatId) {
    const rows = await db
      .select({ id: communities.id, name: communities.name, slug: communities.slug })
      .from(telegramConnections)
      .innerJoin(communities, eq(telegramConnections.communityId, communities.id))
      .where(eq(telegramConnections.telegramChatId, chatId))
      .limit(1);
    return rows[0];
  },
  async findMember(communityId, telegramUserId) {
    const rows = await db
      .select({ id: members.id, telegramUserId: members.telegramUserId, username: members.username, role: members.role })
      .from(members)
      .where(and(eq(members.communityId, communityId), eq(members.telegramUserId, telegramUserId)))
      .limit(1);
    return rows[0] as
      | { id: string; telegramUserId: string; username: string | null; role: string }
      | undefined;
  },
  async findMessage(communityId, telegramMessageId) {
    const rows = await db
      .select({
        id: messages.id,
        telegramMessageId: messages.telegramMessageId,
        text: messages.text,
        kind: messages.kind,
        sentAt: messages.sentAt,
        memberId: messages.memberId,
      })
      .from(messages)
      .where(and(eq(messages.communityId, communityId), eq(messages.telegramMessageId, telegramMessageId)))
      .limit(1);
    return rows[0];
  },
  async recentMessages(communityId, limit) {
    const rows = await db
      .select({
        telegramMessageId: messages.telegramMessageId,
        text: messages.text,
        sentAt: messages.sentAt,
        memberTelegramId: members.telegramUserId,
      })
      .from(messages)
      .leftJoin(members, eq(messages.memberId, members.id))
      .where(eq(messages.communityId, communityId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      telegramMessageId: r.telegramMessageId,
      senderTelegramId: r.memberTelegramId,
      text: r.text,
      sentAt: r.sentAt,
    }));
  },
  async activePolicies(communityId) {
    const rows = await db
      .select({ id: policies.id, name: policies.name, rules: policies.rules })
      .from(policies)
      .where(and(eq(policies.communityId, communityId), eq(policies.isActive, true)));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      rules: (r.rules ?? {}) as Record<string, unknown>,
    }));
  },
  async adminTelegramId(communityId) {
    const rows = await db
      .select({ adminTelegramUserId: telegramConnections.adminTelegramUserId })
      .from(telegramConnections)
      .where(eq(telegramConnections.communityId, communityId))
      .limit(1);
    return rows[0]?.adminTelegramUserId ?? null;
  },
  async recordAction(row) {
    const inserted = await db
      .insert(agentActions)
      .values({
        communityId: row.communityId,
        kind: row.tool,
        status: row.status,
        detail: row.detail,
      })
      .returning({ id: agentActions.id });
    return inserted[0].id;
  },
  async recordAlert(row) {
    const inserted = await db
      .insert(alerts)
      .values({
        communityId: row.communityId,
        severity: row.severity,
        title: row.title,
        body: row.body,
      })
      .returning({ id: alerts.id });
    return inserted[0].id;
  },
  async recordApproval(row) {
    const inserted = await db
      .insert(approvals)
      .values({
        communityId: row.communityId,
        kind: row.kind,
        title: row.title,
        detail: row.detail,
        status: "pending",
        requestedBy: "agent-runtime",
      })
      .returning({ id: approvals.id });
    return inserted[0].id;
  },
  async log(row) {
    await db.insert(activityLogs).values({
      communityId: row.communityId,
      actorType: "agent",
      event: row.event,
      detail: row.detail,
    });
  },
};
