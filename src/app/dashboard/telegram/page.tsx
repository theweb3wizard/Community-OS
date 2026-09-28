import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db";
import {
  communities,
  communityLinkCodes,
  telegramConnections,
} from "@/db/schema";
import { Card, SectionHeader } from "@/components/ui/primitives";
import { requireOperator } from "@/lib/authz";
import { TelegramClient } from "@/lib/telegram/client";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join("");
}

async function uniqueCommunitySlug(base: string): Promise<string> {
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "community";
  for (let i = 0; i < 5; i++) {
    const slug = `${clean}-${randomBytes(2).toString("hex")}`;
    const existing = await db
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.slug, slug))
      .limit(1);
    if (existing.length === 0) return slug;
  }
  throw new Error("could not generate a unique slug");
}

async function createCommunity(formData: FormData) {
  "use server";
  await requireOperator();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!name) redirect("/dashboard/telegram?s=name_required");
  const slug = await uniqueCommunitySlug(name);
  await db.insert(communities).values({ name, slug });
  redirect("/dashboard/telegram?s=community_created");
}

async function createCode(formData: FormData) {
  "use server";
  await requireOperator();
  const communityId = String(formData.get("communityId") ?? "");
  const purpose = String(formData.get("purpose") ?? "");
  if (!communityId || (purpose !== "connect" && purpose !== "admin")) {
    redirect("/dashboard/telegram?s=invalid_request");
  }
  for (let i = 0; i < 5; i++) {
    try {
      await db.insert(communityLinkCodes).values({
        communityId,
        code: newCode(),
        purpose,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      redirect("/dashboard/telegram?s=code_created");
    } catch {
      // code collision — retry with a fresh one
    }
  }
  redirect("/dashboard/telegram?s=code_failed");
}

async function verifyConnection(formData: FormData) {
  "use server";
  await requireOperator();
  const connectionId = String(formData.get("connectionId") ?? "");
  const rows = await db
    .select()
    .from(telegramConnections)
    .where(eq(telegramConnections.id, connectionId))
    .limit(1);
  const connection = rows[0];
  if (!connection?.telegramChatId) redirect("/dashboard/telegram?s=verify_failed");
  let client: TelegramClient;
  try {
    client = TelegramClient.fromEnv();
  } catch {
    redirect("/dashboard/telegram?s=token_missing");
  }
  try {
    const chat = await client.getChat(connection.telegramChatId);
    const me = await client.getMe();
    let isAdmin = false;
    try {
      const membership = await client.getChatMember(
        connection.telegramChatId,
        me.id,
      );
      isAdmin =
        membership.status === "administrator" || membership.status === "creator";
    } catch {
      isAdmin = false;
    }
    await db
      .update(telegramConnections)
      .set({
        chatTitle: chat.title ?? chat.username ?? null,
        chatType: chat.type,
        botUsername: me.username ?? connection.botUsername,
        status: "connected",
        config: { ...(connection.config ?? {}), botIsAdmin: isAdmin },
        updatedAt: new Date(),
      })
      .where(eq(telegramConnections.id, connection.id));
    redirect(
      `/dashboard/telegram?s=${isAdmin ? "verified_admin" : "verified_member"}`,
    );
  } catch {
    redirect("/dashboard/telegram?s=verify_failed");
  }
}

async function sendTestDM(formData: FormData) {
  "use server";
  await requireOperator();
  const connectionId = String(formData.get("connectionId") ?? "");
  const rows = await db
    .select()
    .from(telegramConnections)
    .where(eq(telegramConnections.id, connectionId))
    .limit(1);
  const connection = rows[0];
  if (!connection?.adminTelegramUserId) {
    redirect("/dashboard/telegram?s=no_admin");
  }
  let client: TelegramClient;
  try {
    client = TelegramClient.fromEnv();
  } catch {
    redirect("/dashboard/telegram?s=token_missing");
  }
  try {
    await client.sendAdminNotification(
      connection.adminTelegramUserId,
      "✅ CommunityOS test",
      "Your administrator Telegram is linked and receiving DMs.",
    );
    redirect("/dashboard/telegram?s=dm_sent");
  } catch {
    redirect("/dashboard/telegram?s=dm_failed");
  }
}

const STATUS_MESSAGES: Record<string, string> = {
  community_created: "Community created. Generate a connect code below.",
  code_created: "Fresh code generated (valid 30 minutes, single use).",
  code_failed: "Could not generate a unique code — try again.",
  verified_admin: "Verified: chat reachable and the bot is an administrator.",
  verified_member: "Verified: chat reachable, but the bot is NOT an administrator (moderation actions will fail).",
  verify_failed: "Verification failed: Telegram could not resolve this chat. Is the bot still a member?",
  token_missing: "TELEGRAM_BOT_TOKEN is not configured on the server.",
  no_admin: "No administrator Telegram linked for this community yet — use an admin code first.",
  dm_sent: "Test DM sent. Check the administrator's Telegram.",
  dm_failed: "Test DM failed: Telegram rejected the send (did the admin start the bot?).",
  name_required: "Community name is required.",
  invalid_request: "Invalid request.",
};

export default async function TelegramPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string }>;
}) {
  const params = await searchParams;
  const banner = params.s ? STATUS_MESSAGES[params.s] : null;

  let bot: {
    username?: string;
    id: number;
    canReadAll?: boolean;
  } | null = null;
  let tokenMissing = false;
  try {
    const client = TelegramClient.fromEnv();
    const me = await client.getMe();
    bot = {
      username: me.username,
      id: me.id,
      canReadAll: (me as { can_read_all_group_messages?: boolean })
        .can_read_all_group_messages,
    };
  } catch {
    tokenMissing = true;
  }

  const communityRows = await db.select().from(communities);
  const connectionRows = await db.select().from(telegramConnections);
  const now = new Date();
  const codeRows = await db
    .select()
    .from(communityLinkCodes)
    .where(
      and(isNull(communityLinkCodes.usedAt), gt(communityLinkCodes.expiresAt, now)),
    );
  const communityName = (id: string) =>
    communityRows.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <SectionHeader
        title="Telegram"
        description="Connect Telegram groups to communities and link administrator DMs. Identity is keyed on Telegram numeric IDs, never usernames."
      />
      {banner ? (
        <p className="mb-4 rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          {banner}
        </p>
      ) : null}

      <div className="grid gap-4">
        <Card
          title="Bot"
          hint="Token lives in TELEGRAM_BOT_TOKEN (server env only) and is verified live via getMe."
        >
          {bot ? (
            <div className="text-sm">
              <p>
                <span className="font-semibold">@{bot.username ?? "?"}</span>{" "}
                <span className="text-zinc-500">(id {bot.id})</span>
              </p>
              <p className="mt-1 text-zinc-500">
                Group privacy:{" "}
                {bot.canReadAll === true
                  ? "disabled — bot sees all group messages."
                  : bot.canReadAll === false
                    ? "ENABLED — bot only sees commands/replies. Disable via @BotFather /setprivacy, then re-add the bot (or make it an admin)."
                    : "unknown"}
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              {tokenMissing
                ? "Not configured. Create a bot with @BotFather, set TELEGRAM_BOT_TOKEN in .env.local, then register the webhook (see README)."
                : "Bot unreachable."}
            </p>
          )}
        </Card>

        <Card
          title="Communities"
          hint="Create the CommunityOS community first, then bind a real Telegram chat with a /connect code."
        >
          <form action={createCommunity} className="mb-4 flex gap-2">
            <input
              name="name"
              required
              maxLength={80}
              placeholder="e.g. Acme Protocol"
              className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="submit"
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              Create
            </button>
          </form>
          {communityRows.length === 0 ? (
            <p className="text-sm text-zinc-500">No communities yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {communityRows.map((c) => {
                const conns = connectionRows.filter((r) => r.communityId === c.id);
                const codes = codeRows.filter((r) => r.communityId === c.id);
                return (
                  <li
                    key={c.id}
                    className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <p className="text-sm font-semibold">{c.name}</p>
                    {conns.length === 0 ? (
                      <p className="mt-1 text-xs text-zinc-500">
                        No Telegram chat linked.
                      </p>
                    ) : (
                      <ul className="mt-2 flex flex-col gap-2">
                        {conns.map((conn) => (
                          <li key={conn.id} className="text-xs text-zinc-600 dark:text-zinc-400">
                            <span className="font-mono">
                              {conn.chatTitle ?? conn.telegramChatId ?? "(admin only)"}
                            </span>{" "}
                            · {conn.chatType ?? "—"} · status {conn.status} ·
                            admin{" "}
                            {conn.adminTelegramUserId
                              ? `linked (${conn.adminTelegramUserId})`
                              : "not linked"}
                            <span className="ml-2 inline-flex gap-2">
                              {conn.telegramChatId ? (
                                <form action={verifyConnection} className="inline">
                                  <input
                                    type="hidden"
                                    name="connectionId"
                                    value={conn.id}
                                  />
                                  <button
                                    type="submit"
                                    className="underline hover:no-underline"
                                  >
                                    Verify
                                  </button>
                                </form>
                              ) : null}
                              {conn.adminTelegramUserId ? (
                                <form action={sendTestDM} className="inline">
                                  <input
                                    type="hidden"
                                    name="connectionId"
                                    value={conn.id}
                                  />
                                  <button
                                    type="submit"
                                    className="underline hover:no-underline"
                                  >
                                    Test DM
                                  </button>
                                </form>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <form action={createCode} className="inline">
                        <input type="hidden" name="communityId" value={c.id} />
                        <input type="hidden" name="purpose" value="connect" />
                        <button
                          type="submit"
                          className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                        >
                          New connect code
                        </button>
                      </form>
                      <form action={createCode} className="inline">
                        <input type="hidden" name="communityId" value={c.id} />
                        <input type="hidden" name="purpose" value="admin" />
                        <button
                          type="submit"
                          className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                        >
                          New admin code
                        </button>
                      </form>
                      {codes.map((code) => (
                        <span
                          key={code.id}
                          className="rounded bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900"
                        >
                          {code.purpose === "connect" ? "/connect " : "/admin "}
                          {code.code}
                        </span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card
          title="How to connect"
          hint="The chat ID is never typed in — it is read from the real Telegram update when the code is redeemed."
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Add the bot to your Telegram group (administrator recommended for moderation).</li>
            <li>
              If the bot must observe all messages, disable privacy via
              @BotFather /setprivacy and re-add it — otherwise it only sees
              commands, replies, and mentions.
            </li>
            <li>Generate a connect code above and send `/connect CODE` in the group.</li>
            <li>For admin DMs: start the bot privately, generate an admin code, send `/admin CODE` to the bot.</li>
            <li>Register the webhook so updates arrive: `npm run telegram:webhook:set` (needs public https APP_URL).</li>
          </ol>
          <p className="mt-3 text-xs text-zinc-400">
            Active codes for other communities:{" "}
            {codeRows.length === 0
              ? "none"
              : codeRows.map((c) => `${c.purpose}:${communityName(c.communityId)}`).join(", ")}
          </p>
        </Card>
      </div>
    </div>
  );
}
