import "../src/db/load-env";
import { TelegramClient } from "../src/lib/telegram/client";

// Usage:
//   npx tsx scripts/telegram.ts info
//   npx tsx scripts/telegram.ts set-webhook
//   npx tsx scripts/telegram.ts delete-webhook
//
// Requires TELEGRAM_BOT_TOKEN. set-webhook additionally requires APP_URL
// (public https, no trailing slash) and TELEGRAM_WEBHOOK_SECRET.

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member"];

async function main() {
  const cmd = process.argv[2];
  const client = TelegramClient.fromEnv();

  if (cmd === "info") {
    const me = await client.getMe();
    console.log(`BOT_OK id=${me.id} username=@${me.username ?? "?"} name=${me.first_name ?? ""}`);
    console.log(
      `PRIVACY can_read_all_group_messages=${(me as { can_read_all_group_messages?: boolean }).can_read_all_group_messages ?? "unknown"} (disable via @BotFather /setprivacy for full group visibility, then re-add the bot)`,
    );
    const hook = await client.getWebhookInfo();
    console.log(`WEBHOOK url=${hook.url || "(none)"} pending=${hook.pending_update_count}`);
    if (hook.last_error_message) {
      console.log(`LAST_ERROR ${hook.last_error_date} ${hook.last_error_message}`);
    }
    return;
  }

  if (cmd === "set-webhook") {
    const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) {
      console.error(
        "BLOCKED: APP_URL must be a public https URL (Telegram cannot reach localhost). Deploy the app or expose it via a tunnel, then set APP_URL.",
      );
      process.exit(2);
    }
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
      console.error(
        "BLOCKED: TELEGRAM_WEBHOOK_SECRET must be 16-256 chars of A-Za-z0-9_- (Telegram secret_token rules). Generate: openssl rand -base64 32 | tr -dc 'A-Za-z0-9_-' | head -c 32",
      );
      process.exit(2);
    }
    const url = `${base}/api/telegram/webhook`;
    await client.setWebhook({
      url,
      secretToken: secret,
      allowedUpdates: ALLOWED_UPDATES,
    });
    const hook = await client.getWebhookInfo();
    console.log(`WEBHOOK_SET url=${hook.url} pending=${hook.pending_update_count}`);
    return;
  }

  if (cmd === "delete-webhook") {
    await client.deleteWebhook();
    console.log("WEBHOOK_DELETED");
    return;
  }

  if (cmd === "peek") {
    // Read-only look at queued updates WITHOUT confirming them (no offset),
    // so a later webhook registration still receives everything.
    const updates = await client.getUpdates();
    console.log(`QUEUED_${updates.length}`);
    for (const u of updates.slice(-10)) {
      const m =
        u.message ?? u.edited_message ?? u.my_chat_member ?? u.callback_query;
      console.log(
        `update=${u.update_id} kind=${u.message ? "message" : u.edited_message ? "edited" : u.my_chat_member ? "my_chat_member" : u.callback_query ? "callback" : "other"}`,
      );
      const chat = (m as { chat?: { id: number; type: string; title?: string } })
        ?.chat;
      if (chat) console.log(`  chat=${chat.id} type=${chat.type} title=${chat.title ?? "?"}`);
    }
    return;
  }

  console.error("usage: tsx scripts/telegram.ts <info|set-webhook|delete-webhook|peek>");
  process.exit(2);
}

void main();
