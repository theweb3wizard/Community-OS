import type { TelegramClient } from "@/lib/telegram/client";
import type { AgentStore } from "./store";
import type {
  ActionResult,
  AgentContext,
  AgentDecision,
  ProposedAction,
  ToolName,
} from "./types";
import { REGISTERED_TOOLS } from "./types";

export class ToolNotRegisteredError extends Error {
  constructor(tool: string) {
    super(`tool not registered: ${tool}`);
    this.name = "ToolNotRegisteredError";
  }
}

export interface ToolExecContext {
  cycleId: string;
  client?: TelegramClient;
  store: AgentStore;
  context: AgentContext;
  decision: AgentDecision;
  action: ProposedAction;
}

export interface ToolOutcome {
  ok: boolean;
  detail?: Record<string, unknown>;
  error?: string;
  telegramMessageId?: number;
}

type ToolImpl = (ctx: ToolExecContext) => Promise<ToolOutcome>;

function requireClient(ctx: ToolExecContext): TelegramClient {
  if (!ctx.client) throw new Error("no_telegram_client");
  return ctx.client;
}

/** Execution targets come ONLY from the triggering event. */
function targetMessage(ctx: ToolExecContext): { chatId: number; messageId: number } {
  const chatId = Number(ctx.context.event.chatId);
  const messageId = ctx.context.event.messageId;
  if (!Number.isFinite(chatId) || chatId === 0 || messageId === undefined) {
    throw new Error("no_message_target");
  }
  return { chatId, messageId };
}

function strArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v.slice(0, 500) : fallback;
}

const impls: Record<ToolName, ToolImpl> = {
  send_reply: async (ctx) => {
    const client = requireClient(ctx);
    const { chatId, messageId } = targetMessage(ctx);
    const text = strArg(ctx.action.args, "text", "").slice(0, 4000);
    if (!text) throw new Error("reply_text_required");
    const sent = await client.reply(chatId, messageId, text);
    return { ok: true, telegramMessageId: sent.message_id, detail: { chatId } };
  },
  delete_message: async (ctx) => {
    const client = requireClient(ctx);
    const { chatId, messageId } = targetMessage(ctx);
    await client.deleteMessage(chatId, messageId);
    return { ok: true, detail: { chatId, messageId } };
  },
  warn_user: async (ctx) => {
    const client = requireClient(ctx);
    const { chatId, messageId } = targetMessage(ctx);
    const reason = strArg(ctx.action.args, "reason", "community rules");
    const sent = await client.reply(
      chatId,
      messageId,
      `Warning: ${reason}. Further violations may lead to restrictions.`,
    );
    return { ok: true, telegramMessageId: sent.message_id, detail: { chatId } };
  },
  restrict_user: async (ctx) => {
    const client = requireClient(ctx);
    const chatId = Number(ctx.context.event.chatId);
    const userId = ctx.context.event.sender?.id;
    if (!Number.isFinite(chatId) || chatId === 0 || !userId) {
      throw new Error("no_restrict_target");
    }
    const minutes = Math.min(
      Math.max(Number(ctx.action.args.durationMinutes ?? 60) || 60, 1),
      24 * 60,
    );
    await client.restrictUser(
      chatId,
      Number(userId),
      {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false,
      },
      Math.floor(Date.now() / 1000) + minutes * 60,
    );
    return { ok: true, detail: { chatId, userId, minutes } };
  },
  create_alert: async (ctx) => {
    const severity = strArg(ctx.action.args, "severity", "info") || "info";
    const title =
      strArg(ctx.action.args, "title", `${ctx.decision.classification} detected`) ||
      `${ctx.decision.classification} detected`;
    const id = await ctx.store.recordAlert({
      communityId: ctx.context.community.id,
      severity,
      title,
      body: ctx.decision.rationale,
    });
    return { ok: true, detail: { alertId: id, severity } };
  },
  escalate: async (ctx) => {
    const severity = strArg(ctx.action.args, "severity", "high") || "high";
    const note = strArg(ctx.action.args, "note", ctx.decision.rationale);
    const id = await ctx.store.recordAlert({
      communityId: ctx.context.community.id,
      severity,
      title: `Escalation: ${ctx.decision.classification}`,
      body: note || null,
    });
    return { ok: true, detail: { alertId: id, severity } };
  },
};

export function listTools(): ToolName[] {
  return [...REGISTERED_TOOLS];
}

export function isRegistered(tool: string): tool is ToolName {
  return (REGISTERED_TOOLS as readonly string[]).includes(tool);
}

/** Defense in depth: the runtime validates decisions first, but the registry
 * itself also refuses anything outside the curated set. */
export async function executeTool(
  tool: string,
  ctx: ToolExecContext,
): Promise<ToolOutcome> {
  if (!isRegistered(tool)) throw new ToolNotRegisteredError(tool);
  return impls[tool](ctx);
}

export type { ActionResult };
