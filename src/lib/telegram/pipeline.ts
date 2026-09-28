import { and, eq, gt, isNull } from "drizzle-orm";

import { db } from "@/db";
import {
  activityLogs,
  communities,
  communityLinkCodes,
  members,
  messages,
  processedUpdates,
  telegramConnections,
} from "@/db/schema";
import { TelegramClient } from "./client";
import type { NormalizedEvent, NormalizedSender } from "./normalize";

// Stage separation for the future agent runtime:
//   receive (webhook route) -> normalize (normalize.ts) -> resolve+signin here
//   -> persist here -> process (commands/membership below).
// Prompts 3+ will consume NormalizedEvent + persisted rows for AI decisions.

export type PipelineStatus =
  | "processed"
  | "duplicate"
  | "unlinked"
  | "unsupported"
  | "rejected";

export interface PipelineOutcome {
  status: PipelineStatus;
  communityId?: string;
  memberId?: string;
  messageId?: string;
  replySent?: boolean;
  detail?: string;
}

async function logActivity(
  communityId: string | null,
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(activityLogs).values({
    communityId,
    actorType: "system",
    event,
    detail,
  });
}

async function claimUpdate(updateId: number): Promise<boolean> {
  const rows = await db
    .insert(processedUpdates)
    .values({ updateId })
    .onConflictDoNothing()
    .returning({ updateId: processedUpdates.updateId });
  return rows.length > 0;
}

async function findConnectionByChat(chatId: string) {
  const rows = await db
    .select()
    .from(telegramConnections)
    .where(eq(telegramConnections.telegramChatId, chatId))
    .limit(1);
  return rows[0];
}

async function upsertMember(
  communityId: string,
  sender: NormalizedSender,
  joinedAt?: Date,
): Promise<string> {
  const existing = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.communityId, communityId),
        eq(members.telegramUserId, sender.id),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(members)
      .set({
        username: sender.username ?? null,
        firstName: sender.firstName ?? null,
        updatedAt: new Date(),
      })
      .where(eq(members.id, existing[0].id));
    return existing[0].id;
  }
  const inserted = await db
    .insert(members)
    .values({
      communityId,
      telegramUserId: sender.id,
      username: sender.username ?? null,
      firstName: sender.firstName ?? null,
      role: sender.isBot ? "bot" : "member",
      joinedAt: joinedAt ?? null,
    })
    .returning({ id: members.id });
  return inserted[0].id;
}

function classifyMessage(event: NormalizedEvent): string {
  if (event.newMembers?.length || event.leftMember) return "service";
  if (event.migratedToChatId) return "service";
  if (event.text?.startsWith("/")) return "command";
  return "text";
}

async function persistMessage(
  communityId: string,
  memberId: string | undefined,
  event: NormalizedEvent,
  isEdit: boolean,
): Promise<{ id: string; created: boolean }> {
  const row = {
    communityId,
    memberId: memberId ?? null,
    telegramMessageId: event.messageId !== undefined ? String(event.messageId) : null,
    text: event.text ?? null,
    kind: classifyMessage(event),
    sentAt: event.sentAt ?? null,
  };
  if (!isEdit) {
    const inserted = await db
      .insert(messages)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (inserted.length > 0) return { id: inserted[0].id, created: true };
    const existing = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.communityId, communityId),
          eq(messages.telegramMessageId, String(event.messageId)),
        ),
      )
      .limit(1);
    return { id: existing[0].id, created: false };
  }
  const updated = await db
    .insert(messages)
    .values(row)
    .onConflictDoUpdate({
      target: [messages.communityId, messages.telegramMessageId],
      set: { text: row.text, kind: row.kind, updatedAt: new Date() },
    })
    .returning({ id: messages.id });
  return { id: updated[0].id, created: false };
}

async function consumeLinkCode(
  code: string,
  purpose: string,
): Promise<{ id: string; communityId: string } | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(communityLinkCodes)
    .where(
      and(
        eq(communityLinkCodes.code, code),
        eq(communityLinkCodes.purpose, purpose),
        isNull(communityLinkCodes.usedAt),
        gt(communityLinkCodes.expiresAt, now),
      ),
    )
    .limit(1);
  const found = rows[0];
  if (!found) return null;
  await db
    .update(communityLinkCodes)
    .set({ usedAt: now })
    .where(eq(communityLinkCodes.id, found.id));
  return { id: found.id, communityId: found.communityId };
}

async function bindCommunityChat(opts: {
  communityId: string;
  chatId: string;
  chatTitle?: string;
  chatType: string;
  botUsername?: string;
}): Promise<void> {
  const existing = await db
    .select({ id: telegramConnections.id })
    .from(telegramConnections)
    .where(eq(telegramConnections.telegramChatId, opts.chatId))
    .limit(1);
  if (existing[0]) {
    await db
      .update(telegramConnections)
      .set({
        communityId: opts.communityId,
        chatTitle: opts.chatTitle ?? null,
        chatType: opts.chatType,
        botUsername: opts.botUsername ?? null,
        status: "connected",
        updatedAt: new Date(),
      })
      .where(eq(telegramConnections.id, existing[0].id));
    return;
  }
  await db.insert(telegramConnections).values({
    communityId: opts.communityId,
    telegramChatId: opts.chatId,
    chatTitle: opts.chatTitle ?? null,
    chatType: opts.chatType,
    botUsername: opts.botUsername ?? null,
    status: "connected",
  });
}

// Cached bot identity (stable per token; avoids a getMe call per update).
let cachedBotId: string | null = null;
async function getBotId(client: TelegramClient): Promise<string> {
  if (!cachedBotId) cachedBotId = String((await client.getMe()).id);
  return cachedBotId;
}

export function resetBotIdCache(): void {
  cachedBotId = null;
}

function parseCommand(text: string): { command: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [raw, ...rest] = trimmed.split(/\s+/);
  // Strip optional @BotName suffix: /connect@MyBot CODE
  const command = raw.split("@")[0].toLowerCase();
  return { command, arg: (rest[0] ?? "").trim().toUpperCase() };
}

const HELP_PRIVATE = [
  "Hello! I'm the CommunityOS operations bot.",
  "",
  "To link your Telegram account as a community administrator, ask your workspace owner for an admin code, then send:",
  "/admin CODE",
  "",
  "To connect a group, add me to the group and send there:",
  "/connect CODE",
  "(Ask the owner to generate the code on the CommunityOS dashboard under Telegram.)",
].join("\n");

export async function runPipeline(
  event: NormalizedEvent,
  deps: { client?: TelegramClient } = {},
): Promise<PipelineOutcome> {
  const { client } = deps;

  // 1. Dedupe — Telegram redelivers updates until it sees 2xx.
  if (!(await claimUpdate(event.updateId))) {
    return { status: "duplicate", detail: `update ${event.updateId} already seen` };
  }

  // 2. Callback queries: always acknowledge (clients show a spinner until
  // answerCallbackQuery). Approval/rejection execution belongs to Prompt 3+.
  if (event.kind === "callback_query") {
    if (client && event.callbackId) {
      try {
        const approvalLike =
          event.callbackData?.startsWith("approve:") ||
          event.callbackData?.startsWith("reject:");
        await client.answerCallbackQuery(event.callbackId, {
          text: approvalLike
            ? "Approval actions arrive in the next CommunityOS release."
            : undefined,
        });
      } catch (error) {
        await logActivity(null, "telegram.callback_answer_failed", {
          updateId: event.updateId,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return { status: "processed", detail: "callback_acknowledged" };
  }

  // 3. Bot membership transitions (added/removed/blocked).
  if (event.kind === "my_chat_member") {
    const connection = await findConnectionByChat(event.chatId);
    const removed =
      event.newMembership === "left" || event.newMembership === "kicked";
    if (connection) {
      await db
        .update(telegramConnections)
        .set({ status: removed ? "disconnected" : "connected", updatedAt: new Date() })
        .where(eq(telegramConnections.id, connection.id));
      await logActivity(connection.communityId, "telegram.bot_membership", {
        chatId: event.chatId,
        chatTitle: event.chatTitle,
        status: removed ? "disconnected" : "connected",
      });
      return {
        status: "processed",
        communityId: connection.communityId,
        detail: `bot_${removed ? "removed" : "added"}`,
      };
    }
    await logActivity(null, "telegram.bot_membership_unlinked", {
      chatId: event.chatId,
      chatTitle: event.chatTitle,
      membership: event.newMembership,
    });
    return { status: "unlinked", detail: "bot_membership_unknown_chat" };
  }

  if (event.kind === "unsupported") {
    return { status: "unsupported", detail: `update ${event.updateId}` };
  }

  // 4. Group -> supergroup migration: the chat keeps its identity, Telegram
  // issues a new numeric id. Move the binding so history stays attached.
  if (event.migratedToChatId) {
    const connection = await findConnectionByChat(event.chatId);
    if (connection) {
      await db
        .update(telegramConnections)
        .set({
          telegramChatId: event.migratedToChatId,
          chatType: "supergroup",
          updatedAt: new Date(),
        })
        .where(eq(telegramConnections.id, connection.id));
      await logActivity(connection.communityId, "telegram.chat_migrated", {
        from: event.chatId,
        to: event.migratedToChatId,
      });
      return {
        status: "processed",
        communityId: connection.communityId,
        detail: "chat_migrated",
      };
    }
    return { status: "unlinked", detail: "migration_unknown_chat" };
  }

  // 5. Commands that work without (or to establish) a community binding.
  const cmd = event.text ? parseCommand(event.text) : null;
  if (cmd && client) {
    if (cmd.command === "/connect" && event.chatType !== "private") {
      const link = cmd.arg ? await consumeLinkCode(cmd.arg, "connect") : null;
      if (!link) {
        await client.reply(
          Number(event.chatId),
          Number(event.messageId ?? 0),
          "Unknown or expired code. Ask your CommunityOS owner to generate a fresh one (Dashboard → Telegram).",
        );
        return { status: "processed", replySent: true, detail: "connect_invalid_code" };
      }
      let botUsername: string | undefined;
      try {
        botUsername = (await client.getMe()).username;
      } catch {
        botUsername = undefined;
      }
      await bindCommunityChat({
        communityId: link.communityId,
        chatId: event.chatId,
        chatTitle: event.chatTitle,
        chatType: event.chatType,
        botUsername,
      });
      const [community] = await db
        .select({ name: communities.name })
        .from(communities)
        .where(eq(communities.id, link.communityId))
        .limit(1);
      await client.reply(
        Number(event.chatId),
        Number(event.messageId ?? 0),
        `Connected to CommunityOS community “${community?.name ?? link.communityId}”. I'll start observing here.`,
      );
      await logActivity(link.communityId, "telegram.chat_connected", {
        chatId: event.chatId,
        chatTitle: event.chatTitle,
      });
      return {
        status: "processed",
        communityId: link.communityId,
        replySent: true,
        detail: "chat_connected",
      };
    }
    if (cmd.command === "/admin" && event.chatType === "private" && event.sender) {
      const link = cmd.arg ? await consumeLinkCode(cmd.arg, "admin") : null;
      if (!link) {
        await client.sendMessage(
          Number(event.sender.id),
          "Unknown or expired admin code. Ask your CommunityOS owner for a fresh one.",
        );
        return { status: "processed", replySent: true, detail: "admin_invalid_code" };
      }
      const existing = await db
        .select({ id: telegramConnections.id })
        .from(telegramConnections)
        .where(eq(telegramConnections.communityId, link.communityId))
        .limit(1);
      if (existing[0]) {
        await db
          .update(telegramConnections)
          .set({ adminTelegramUserId: event.sender.id, updatedAt: new Date() })
          .where(eq(telegramConnections.id, existing[0].id));
      } else {
        await db.insert(telegramConnections).values({
          communityId: link.communityId,
          adminTelegramUserId: event.sender.id,
          status: "admin_linked",
        });
      }
      await client.sendMessage(
        Number(event.sender.id),
        "Administrator Telegram linked. You'll receive approval requests and alerts here.",
      );
      await logActivity(link.communityId, "telegram.admin_linked", {
        telegramUserId: event.sender.id,
        username: event.sender.username ?? null,
      });
      return {
        status: "processed",
        communityId: link.communityId,
        replySent: true,
        detail: "admin_linked",
      };
    }
    if (cmd.command === "/start" && event.chatType === "private" && event.sender) {
      await client.sendMessage(Number(event.sender.id), HELP_PRIVATE);
      return { status: "processed", replySent: true, detail: "help_sent" };
    }
  }

  // 6. Resolve community for ordinary messages.
  const connection = await findConnectionByChat(event.chatId);
  if (!connection) {
    // Bot freshly added to an unknown group: introduce itself once.
    if (
      client &&
      event.newMembers &&
      event.chatType !== "private" &&
      event.sender
    ) {
      try {
        const botId = await getBotId(client);
        if (event.newMembers.some((m) => m.id === botId)) {
          await client.sendMessage(
            Number(event.chatId),
            "Hello! I'm the CommunityOS operations bot. Ask a community owner to run /connect CODE here (generate the code on the dashboard under Telegram).",
          );
          return { status: "unlinked", replySent: true, detail: "bot_intro_sent" };
        }
      } catch {
        // fall through
      }
    }
    return { status: "unlinked", detail: `unknown_chat ${event.chatId}` };
  }

  // 7. Resolve member + persist message.
  let memberId: string | undefined;
  if (event.sender && !event.sender.isBot) {
    memberId = await upsertMember(connection.communityId, event.sender, event.sentAt);
  } else if (event.sender?.isBot && client) {
    try {
      const botId = await getBotId(client);
      if (event.sender.id !== botId) {
        memberId = await upsertMember(connection.communityId, event.sender, event.sentAt);
      }
    } catch {
      memberId = undefined;
    }
  }
  if (event.newMembers) {
    for (const m of event.newMembers) {
      if (m.isBot && client) {
        try {
          if (m.id === (await getBotId(client))) continue;
        } catch {
          // fall through and record
        }
      }
      await upsertMember(connection.communityId, m, event.sentAt);
    }
  }

  if (event.messageId === undefined) {
    return {
      status: "processed",
      communityId: connection.communityId,
      memberId,
      detail: "no_message_to_persist",
    };
  }
  const stored = await persistMessage(
    connection.communityId,
    memberId,
    event,
    event.kind === "edited_message",
  );
  return {
    status: "processed",
    communityId: connection.communityId,
    memberId,
    messageId: stored.id,
    detail: event.kind === "edited_message" ? "message_updated" : "message_stored",
  };
}
