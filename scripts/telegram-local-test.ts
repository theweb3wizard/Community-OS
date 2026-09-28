import "../src/db/load-env";
import { eq } from "drizzle-orm";

import { db } from "../src/db";
import {
  activityLogs,
  communities,
  communityLinkCodes,
  members,
  messages,
  processedUpdates,
  telegramConnections,
} from "../src/db/schema";
import type { TelegramClient } from "../src/lib/telegram/client";
import { normalizeUpdate } from "../src/lib/telegram/normalize";
import { runPipeline } from "../src/lib/telegram/pipeline";

// Automated tests for Prompt 2. No network calls to Telegram: the pipeline
// runs with a stub client. DB assertions run against the real Neon database
// and clean up everything they create (test ids use update_id 800000001+).

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name} ${extra !== undefined ? JSON.stringify(extra) : ""}`);
  }
}

const UID = 800_000_001;
const update = (updateId: number, extra: Record<string, unknown>) => ({
  update_id: updateId,
  ...extra,
});
const user = (id: number, username = "tester") => ({
  id,
  is_bot: false,
  first_name: "Test",
  username,
});
const groupChat = (id: number, title = "Test Group") => ({
  id,
  type: "group",
  title,
});
const textMsg = (messageId: number, chat: object, from: object, text: string, date = 1759000000) => ({
  message_id: messageId,
  date,
  chat,
  from,
  text,
});

function stubClient(calls: Array<Record<string, unknown>>): TelegramClient {
  const stub = {
    getMe: async () => {
      calls.push({ method: "getMe" });
      return { id: 999888777, is_bot: true, first_name: "TestBot", username: "testbot" };
    },
    sendMessage: async (chatId: unknown, text: unknown) => {
      calls.push({ method: "sendMessage", chatId, text });
      return { message_id: 1, date: 1, chat: { id: 1, type: "private" } };
    },
    reply: async (chatId: unknown, messageId: unknown, text: unknown) => {
      calls.push({ method: "reply", chatId, messageId, text });
      return { message_id: 2, date: 1, chat: { id: 1, type: "group" } };
    },
    answerCallbackQuery: async (id: unknown, opts: unknown) => {
      calls.push({ method: "answerCallbackQuery", id, opts });
      return true;
    },
  };
  return stub as unknown as TelegramClient;
}

async function offlineTests() {
  // valid group message
  const r1 = normalizeUpdate(
    update(UID, { message: textMsg(10, groupChat(-100123), user(111), "hello") }),
  );
  check("normalize group message", r1.ok && r1.event.kind === "message" && r1.event.chatId === "-100123");

  // ids become strings, date becomes Date
  if (r1.ok) {
    check("sender id stringified", r1.event.sender?.id === "111");
    check(
      "sentAt correct",
      r1.event.sentAt?.getTime() === 1759000000 * 1000,
      r1.event.sentAt,
    );
  }

  // edited message
  const r2 = normalizeUpdate(
    update(UID + 1, { edited_message: textMsg(10, groupChat(-100123), user(111), "edited") }),
  );
  check("normalize edited", r2.ok && r2.event.kind === "edited_message");

  // callback query
  const r3 = normalizeUpdate(
    update(UID + 2, {
      callback_query: {
        id: "cq1",
        from: user(111),
        message: { message_id: 5, chat: groupChat(-100123) },
        chat_instance: "ci",
        data: "approve:xyz",
      },
    }),
  );
  check("normalize callback", r3.ok && r3.event.kind === "callback_query" && r3.event.callbackData === "approve:xyz");

  // bot membership
  const r4 = normalizeUpdate(
    update(UID + 3, {
      my_chat_member: {
        chat: groupChat(-100123),
        from: user(111),
        date: 1759000000,
        old_chat_member: { status: "left", user: user(999888777) },
        new_chat_member: { status: "member", user: user(999888777) },
      },
    }),
  );
  check("normalize my_chat_member", r4.ok && r4.event.newMembership === "member");

  // malformed
  check("reject missing update_id", normalizeUpdate({ message: {} }).ok === false);
  check("reject non-object", normalizeUpdate("nope").ok === false);
  check("reject null", normalizeUpdate(null).ok === false);
  // unsupported type still acks
  const r5 = normalizeUpdate(update(UID + 4, { inline_query: { id: "1" } }));
  check("unsupported acks", r5.ok && r5.event.kind === "unsupported");
  // caption-only message keeps caption as text
  const r6 = normalizeUpdate(
    update(UID + 5, {
      message: { message_id: 11, date: 1759000000, chat: groupChat(-100123), from: user(111), caption: "cap" },
    }),
  );
  check("caption as text", r6.ok && r6.event.text === "cap");
}

async function pipelineTests() {
  const calls: Array<Record<string, unknown>> = [];
  const client = stubClient(calls);
  const chatId = "-1005550001";
  const adminTgId = "424242";

  // fixture community + codes
  const [community] = await db
    .insert(communities)
    .values({ name: "Prompt2 Test", slug: `p2-test-${Date.now()}` })
    .returning({ id: communities.id });
  const communityId = community.id;
  await db.insert(communityLinkCodes).values({
    communityId,
    code: "TESTC1",
    purpose: "connect",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  await db.insert(communityLinkCodes).values({
    communityId,
    code: "TESTA1",
    purpose: "admin",
    expiresAt: new Date(Date.now() + 3600_000),
  });

  const norm = (u: unknown) => {
    const r = normalizeUpdate(u);
    if (!r.ok) throw new Error("fixture failed to normalize");
    return r.event;
  };

  try {
    // 1. /connect binds the chat
    const o1 = await runPipeline(
      norm(update(UID + 10, { message: textMsg(50, groupChat(Number(chatId), "P2 Group"), user(111), "/connect TESTC1") })),
      { client },
    );
    check("connect binds", o1.status === "processed" && o1.communityId === communityId && o1.replySent === true, o1);
    const conns = await db.select().from(telegramConnections).where(eq(telegramConnections.communityId, communityId));
    check("connection row", conns.length === 1 && conns[0].telegramChatId === chatId && conns[0].status === "connected", conns[0]);

    // 2. ordinary message persists with correct ids/timestamps
    const o2 = await runPipeline(
      norm(update(UID + 11, { message: textMsg(51, groupChat(Number(chatId)), user(111, "alice"), "hello world", 1759000060) })),
      { client },
    );
    check("message stored", o2.status === "processed" && !!o2.messageId && !!o2.memberId, o2);
    const mems = await db.select().from(members).where(eq(members.communityId, communityId));
    check("member keyed on numeric id", mems.length === 1 && mems[0].telegramUserId === "111" && mems[0].username === "alice", mems[0]);
    const msgs = await db.select().from(messages).where(eq(messages.communityId, communityId));
    check(
      "message row correct",
      msgs.length === 1 && msgs[0].telegramMessageId === "51" && msgs[0].text === "hello world" && msgs[0].sentAt?.getTime() === 1759000060 * 1000,
      msgs[0],
    );

    // 3. redelivery dedupes
    const o3 = await runPipeline(
      norm(update(UID + 11, { message: textMsg(51, groupChat(Number(chatId)), user(111, "alice"), "hello world", 1759000060) })),
      { client },
    );
    check("duplicate update ignored", o3.status === "duplicate", o3);

    // 4. edited message updates text
    const o4 = await runPipeline(
      norm(update(UID + 12, { edited_message: textMsg(51, groupChat(Number(chatId)), user(111), "hello edited", 1759000070) })),
      { client },
    );
    check("edit updates", o4.status === "processed" && o4.detail === "message_updated", o4);
    const msgs2 = await db.select().from(messages).where(eq(messages.communityId, communityId));
    check("edited text persisted", msgs2.length === 1 && msgs2[0].text === "hello edited", msgs2[0]);

    // 5. /admin links the administrator
    const o5 = await runPipeline(
      norm(update(UID + 13, { message: textMsg(7, { id: 424242, type: "private" }, { id: Number(adminTgId), is_bot: false, first_name: "Ada", username: "ada" }, "/admin TESTA1") })),
      { client },
    );
    check("admin linked", o5.status === "processed" && o5.communityId === communityId && o5.replySent === true, o5);
    const conns2 = await db.select().from(telegramConnections).where(eq(telegramConnections.communityId, communityId));
    check("admin id stored", conns2[0].adminTelegramUserId === adminTgId, conns2[0]);

    // 6. invalid code rejected safely
    const o6 = await runPipeline(
      norm(update(UID + 14, { message: textMsg(52, groupChat(Number(chatId)), user(111), "/connect WRONG1") })),
      { client },
    );
    check("bad code rejected", o6.status === "processed" && o6.detail === "connect_invalid_code", o6);

    // 7. used code cannot be reused
    const o7 = await runPipeline(
      norm(update(UID + 15, { message: textMsg(53, groupChat(Number(chatId)), user(111), "/connect TESTC1") })),
      { client },
    );
    check("code single-use", o7.detail === "connect_invalid_code", o7);

    // 8. callback acknowledged, approval-like gets deferral note
    const o8 = await runPipeline(
      norm(update(UID + 16, { callback_query: { id: "cq9", from: user(111), message: { message_id: 5, chat: groupChat(Number(chatId)) }, chat_instance: "ci", data: "approve:1" } })),
      { client },
    );
    const ack = calls.find((c) => c.method === "answerCallbackQuery" && c.id === "cq9");
    check("callback acked", o8.status === "processed" && !!ack, { o8, ack });

    // 9. unknown chat stays unlinked
    const o9 = await runPipeline(
      norm(update(UID + 17, { message: textMsg(60, groupChat(-100999888), user(222, "bob"), "stranger") })),
      { client },
    );
    check("unknown chat unlinked", o9.status === "unlinked", o9);

    // 10. bot removed marks disconnected
    const o10 = await runPipeline(
      norm(update(UID + 18, {
        my_chat_member: {
          chat: groupChat(Number(chatId)),
          from: user(111),
          date: 1759000100,
          old_chat_member: { status: "member", user: { id: 999888777, is_bot: true } },
          new_chat_member: { status: "kicked", user: { id: 999888777, is_bot: true } },
        },
      })),
      { client },
    );
    const conns3 = await db.select().from(telegramConnections).where(eq(telegramConnections.communityId, communityId));
    check("kick disconnects", o10.status === "processed" && conns3[0].status === "disconnected", { o10, status: conns3[0]?.status });
  } finally {
    // cleanup (FK order)
    await db.delete(messages).where(eq(messages.communityId, communityId));
    await db.delete(members).where(eq(members.communityId, communityId));
    await db.delete(telegramConnections).where(eq(telegramConnections.communityId, communityId));
    await db.delete(communityLinkCodes).where(eq(communityLinkCodes.communityId, communityId));
    await db.delete(activityLogs).where(eq(activityLogs.communityId, communityId));
    for (let id = UID; id < UID + 30; id++) {
      await db.delete(processedUpdates).where(eq(processedUpdates.updateId, id));
    }
    await db.delete(communities).where(eq(communities.id, communityId));
    const leftover = await db.select({ id: communities.id }).from(communities).where(eq(communities.id, communityId));
    check("cleanup complete", leftover.length === 0);
  }
}

async function main() {
  await offlineTests();
  await pipelineTests();
  console.log(`\nTOTAL passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
