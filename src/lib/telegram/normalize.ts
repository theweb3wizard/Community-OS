import { z } from "zod";

// Validates raw webhook JSON into a NormalizedEvent. Never throws — returns a
// rejection reason instead, so poison updates can't crash the handler.

const UserSchema = z
  .object({
    id: z.number(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const ChatSchema = z
  .object({
    id: z.number(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
    title: z.string().optional(),
    username: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
  })
  .passthrough();

const MessageSchema = z
  .object({
    message_id: z.number(),
    date: z.number(),
    chat: ChatSchema,
    from: UserSchema.optional(),
    sender_chat: ChatSchema.optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    new_chat_members: z.array(UserSchema).optional(),
    left_chat_member: UserSchema.optional(),
    migrate_to_chat_id: z.number().optional(),
    migrate_from_chat_id: z.number().optional(),
  })
  .passthrough();

const CallbackQuerySchema = z
  .object({
    id: z.string(),
    from: UserSchema,
    message: z
      .object({ message_id: z.number(), chat: ChatSchema })
      .passthrough()
      .optional(),
    data: z.string().optional(),
  })
  .passthrough();

const ChatMemberSchema = z
  .object({ status: z.string(), user: UserSchema })
  .passthrough();

const ChatMemberUpdatedSchema = z
  .object({
    chat: ChatSchema,
    from: UserSchema,
    old_chat_member: ChatMemberSchema,
    new_chat_member: ChatMemberSchema,
  })
  .passthrough();

const UpdateSchema = z
  .object({
    update_id: z.number(),
    message: MessageSchema.optional(),
    edited_message: MessageSchema.optional(),
    callback_query: CallbackQuerySchema.optional(),
    my_chat_member: ChatMemberUpdatedSchema.optional(),
  })
  .passthrough();

export type NormalizedKind =
  | "message"
  | "edited_message"
  | "callback_query"
  | "my_chat_member"
  | "unsupported";

export interface NormalizedSender {
  id: string;
  username?: string;
  firstName?: string;
  isBot: boolean;
}

export interface NormalizedEvent {
  updateId: number;
  kind: NormalizedKind;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel" | "unknown";
  chatTitle?: string;
  sender?: NormalizedSender;
  messageId?: number;
  sentAt?: Date;
  text?: string;
  callbackId?: string;
  callbackData?: string;
  newMembers?: NormalizedSender[];
  leftMember?: NormalizedSender;
  migratedToChatId?: string;
  oldMembership?: string;
  newMembership?: string;
  /** The validated update, kept for the future agent runtime. */
  raw: unknown;
}

export type NormalizeResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: string };

function toSender(u: z.infer<typeof UserSchema>): NormalizedSender {
  return {
    id: String(u.id),
    username: u.username,
    firstName: u.first_name,
    isBot: u.is_bot ?? false,
  };
}

export function normalizeUpdate(payload: unknown): NormalizeResult {
  const parsed = UpdateSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "invalid_update_shape" };
  const u = parsed.data;
  const base = { updateId: u.update_id, raw: payload };

  if (u.message) {
    const m = u.message;
    return {
      ok: true,
      event: {
        ...base,
        kind: "message",
        chatId: String(m.chat.id),
        chatType: m.chat.type,
        chatTitle: m.chat.title,
        sender: m.from ? toSender(m.from) : undefined,
        messageId: m.message_id,
        sentAt: new Date(m.date * 1000),
        text: m.text ?? m.caption,
        newMembers: m.new_chat_members?.map(toSender),
        leftMember: m.left_chat_member ? toSender(m.left_chat_member) : undefined,
        migratedToChatId:
          m.migrate_to_chat_id !== undefined
            ? String(m.migrate_to_chat_id)
            : undefined,
      },
    };
  }
  if (u.edited_message) {
    const m = u.edited_message;
    return {
      ok: true,
      event: {
        ...base,
        kind: "edited_message",
        chatId: String(m.chat.id),
        chatType: m.chat.type,
        chatTitle: m.chat.title,
        sender: m.from ? toSender(m.from) : undefined,
        messageId: m.message_id,
        sentAt: new Date(m.date * 1000),
        text: m.text ?? m.caption,
      },
    };
  }
  if (u.callback_query) {
    const c = u.callback_query;
    return {
      ok: true,
      event: {
        ...base,
        kind: "callback_query",
        chatId: c.message ? String(c.message.chat.id) : "0",
        chatType: c.message ? c.message.chat.type : "unknown",
        sender: toSender(c.from),
        messageId: c.message?.message_id,
        callbackId: c.id,
        callbackData: c.data,
      },
    };
  }
  if (u.my_chat_member) {
    const m = u.my_chat_member;
    return {
      ok: true,
      event: {
        ...base,
        kind: "my_chat_member",
        chatId: String(m.chat.id),
        chatType: m.chat.type,
        chatTitle: m.chat.title,
        sender: toSender(m.from),
        oldMembership: m.old_chat_member.status,
        newMembership: m.new_chat_member.status,
      },
    };
  }
  return {
    ok: true,
    event: { ...base, kind: "unsupported", chatId: "0", chatType: "unknown" },
  };
}
