import type {
  InlineKeyboardMarkup,
  TelegramApiEnvelope,
  TelegramChat,
  TelegramChatMember,
  TelegramChatPermissions,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  TelegramWebhookInfo,
} from "./types";

// Server-side only. Never import from client components — the bot token must
// never leave the server. The AI layer (Prompts 3+) may only use these
// curated methods, never arbitrary Bot API calls.

const API_BASE = "https://api.telegram.org";

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly description: string,
    public readonly errorCode?: number,
  ) {
    super(`Telegram ${method} failed: ${description}`);
    this.name = "TelegramApiError";
  }
}

export interface SendMessageOptions {
  parseMode?: "HTML";
  disableNotification?: boolean;
  protectContent?: boolean;
  replyToMessageId?: number;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface AnswerCallbackOptions {
  text?: string;
  showAlert?: boolean;
}

export class TelegramClient {
  private constructor(private readonly token: string) {}

  static fromEnv(): TelegramClient {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and add the token to .env.local (see .env.example).",
      );
    }
    return new TelegramClient(token);
  }

  static isConfigured(): boolean {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN);
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new TelegramApiError(
        method,
        error instanceof Error ? `network error: ${error.message}` : "network error",
      );
    }
    let envelope: TelegramApiEnvelope<T>;
    try {
      envelope = (await res.json()) as TelegramApiEnvelope<T>;
    } catch {
      throw new TelegramApiError(method, `non-JSON response (http ${res.status})`);
    }
    if (!envelope.ok) {
      throw new TelegramApiError(method, envelope.description, envelope.error_code);
    }
    return envelope.result;
  }

  // -- verification / connection -------------------------------------------
  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return this.call<TelegramWebhookInfo>("getWebhookInfo");
  }

  setWebhook(opts: {
    url: string;
    secretToken: string;
    allowedUpdates: string[];
    dropPendingUpdates?: boolean;
  }): Promise<true> {
    return this.call<true>("setWebhook", {
      url: opts.url,
      secret_token: opts.secretToken,
      allowed_updates: opts.allowedUpdates,
      drop_pending_updates: opts.dropPendingUpdates ?? false,
    });
  }

  deleteWebhook(dropPendingUpdates = false): Promise<true> {
    return this.call<true>("deleteWebhook", {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  getChat(chatId: number | string): Promise<TelegramChat> {
    return this.call<TelegramChat>("getChat", { chat_id: chatId });
  }

  getChatMember(
    chatId: number | string,
    userId: number | string,
  ): Promise<TelegramChatMember> {
    return this.call<TelegramChatMember>("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
  }

  getChatAdministrators(chatId: number | string): Promise<TelegramChatMember[]> {
    return this.call<TelegramChatMember[]>("getChatAdministrators", {
      chat_id: chatId,
    });
  }

  // -- messaging -------------------------------------------------------------
  async sendMessage(
    chatId: number | string,
    text: string,
    opts: SendMessageOptions = {},
  ): Promise<TelegramMessage> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.disableNotification !== undefined)
      body.disable_notification = opts.disableNotification;
    if (opts.protectContent !== undefined) body.protect_content = opts.protectContent;
    if (opts.replyToMessageId !== undefined)
      body.reply_parameters = { message_id: opts.replyToMessageId };
    if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
    return this.call<TelegramMessage>("sendMessage", body);
  }

  reply(
    chatId: number | string,
    messageId: number,
    text: string,
    opts: SendMessageOptions = {},
  ): Promise<TelegramMessage> {
    return this.sendMessage(chatId, text, { ...opts, replyToMessageId: messageId });
  }

  editMessage(
    chatId: number | string,
    messageId: number,
    text: string,
    opts: { parseMode?: "HTML"; replyMarkup?: InlineKeyboardMarkup } = {},
  ): Promise<TelegramMessage | true> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
    return this.call<TelegramMessage | true>("editMessageText", body);
  }

  async deleteMessage(
    chatId: number | string,
    messageId: number,
  ): Promise<boolean> {
    return this.call<boolean>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  // -- moderation --------------------------------------------------------------
  async restrictUser(
    chatId: number | string,
    userId: number | string,
    permissions: TelegramChatPermissions,
    untilDate?: number,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      user_id: userId,
      permissions,
    };
    if (untilDate !== undefined) body.until_date = untilDate;
    return this.call<boolean>("restrictChatMember", body);
  }

  liftRestrictions(
    chatId: number | string,
    userId: number | string,
  ): Promise<boolean> {
    return this.restrictUser(chatId, userId, {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: true,
      can_invite_users: true,
      can_pin_messages: true,
      can_manage_topics: true,
    });
  }

  // -- callbacks / admin UX ------------------------------------------------------
  async answerCallbackQuery(
    callbackQueryId: string,
    opts: AnswerCallbackOptions = {},
  ): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (opts.text !== undefined) body.text = opts.text;
    if (opts.showAlert !== undefined) body.show_alert = opts.showAlert;
    return this.call<boolean>("answerCallbackQuery", body);
  }

  sendAdminNotification(
    adminTelegramUserId: number | string,
    title: string,
    body: string,
    buttons: { label: string; data: string }[] = [],
  ): Promise<TelegramMessage> {
    const text = `${title}\n\n${body}`;
    const replyMarkup: InlineKeyboardMarkup | undefined =
      buttons.length > 0
        ? {
            inline_keyboard: buttons.map((b) => [
              { text: b.label, callback_data: b.data },
            ]),
          }
        : undefined;
    return this.sendMessage(adminTelegramUserId, text, { replyMarkup });
  }

  // -- passthrough for webhook plumbing (updates only) -----------------------------
  getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const params: Record<string, unknown> = {};
    if (offset !== undefined) params.offset = offset;
    return this.call<TelegramUpdate[]>("getUpdates", params);
  }
}
