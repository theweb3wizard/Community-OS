import "../src/db/load-env";
import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "../src/db";
import {
  activityLogs,
  agentActions,
  alerts,
  approvals,
  communities,
  members,
  messages,
  policies,
} from "../src/db/schema";
import { runAgentCycle } from "../src/lib/agent/runtime";
import {
  detectFlood,
  detectRepeat,
  domainOf,
  extractUrls,
  isControlCommand,
  matchDomain,
} from "../src/lib/agent/prechecks";
import { validateDecision } from "../src/lib/agent/provider";
import type { DecisionProvider } from "../src/lib/agent/provider";
import type { AgentStore } from "../src/lib/agent/store";
import { executeTool, listTools, ToolNotRegisteredError } from "../src/lib/agent/tools";
import type { TelegramClient } from "../src/lib/telegram/client";
import type { NormalizedEvent } from "../src/lib/telegram/normalize";

// Agent runtime tests. Telegram is stubbed (records calls, can fail on
// demand); the database is the REAL Neon instance. Everything created is
// deleted afterwards. Scenario markers ([spam-test] etc.) drive the
// deterministic provider — documented test-only triggers.

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

interface Call { method: string; [k: string]: unknown }
function stubClient(calls: Call[], fail?: { method: string; error: string }): TelegramClient {
  const maybeFail = (m: string) => {
    if (fail?.method === m) throw new Error(fail.error);
  };
  const stub = {
    getMe: async () => ({ id: 999888777, is_bot: true, first_name: "T", username: "t" }),
    sendMessage: async (chatId: unknown, text: unknown) => {
      calls.push({ method: "sendMessage", chatId, text });
      maybeFail("sendMessage");
      return { message_id: 991, date: 1, chat: { id: 1, type: "private" } };
    },
    reply: async (chatId: unknown, messageId: unknown, text: unknown) => {
      calls.push({ method: "reply", chatId, messageId, text });
      maybeFail("reply");
      return { message_id: 992, date: 1, chat: { id: 1, type: "group" } };
    },
    deleteMessage: async (chatId: unknown, messageId: unknown) => {
      calls.push({ method: "deleteMessage", chatId, messageId });
      maybeFail("deleteMessage");
      return true;
    },
    restrictUser: async (chatId: unknown, userId: unknown, permissions: unknown, until?: unknown) => {
      calls.push({ method: "restrictUser", chatId, userId, permissions, until });
      maybeFail("restrictUser");
      return true;
    },
    answerCallbackQuery: async () => true,
    sendAdminNotification: async (adminId: unknown, title: unknown, body: unknown, buttons: unknown, urlButtons: unknown) => {
      calls.push({ method: "sendAdminNotification", adminId, title, body, buttons, urlButtons });
      maybeFail("sendAdminNotification");
      return { message_id: 993, date: 1, chat: { id: 1, type: "private" } };
    },
    editMessage: async (chatId: unknown, messageId: unknown, text: unknown) => {
      calls.push({ method: "editMessage", chatId, messageId, text });
      maybeFail("editMessage");
      return { message_id: 994, date: 1, chat: { id: 1, type: "private" } };
    },
  };
  return stub as unknown as TelegramClient;
}

const throwingStore: AgentStore = new Proxy(
  {},
  { get: () => { throw new Error("db_down_simulated"); } },
) as AgentStore;

const rogueProvider = {
  name: "rogue",
  decide: async () => ({
    classification: "SPAM",
    confidence: 1,
    rationale: "rogue",
    proposedActions: [{ tool: "banUser", args: {} }],
  }),
} as unknown as DecisionProvider;

const garbageProvider = {
  name: "garbage",
  decide: async () => ({ totally: "wrong" }),
} as unknown as DecisionProvider;

const REAL_CHAT = "-1003320389084";
const REAL_ADMIN_TG = "7651409015";

function msgEvent(o: {
  updateId: number; messageId?: number; senderId?: string; username?: string;
  text?: string; chatId?: string; kind?: NormalizedEvent["kind"];
}): NormalizedEvent {
  return {
    updateId: o.updateId,
    kind: o.kind ?? "message",
    chatId: o.chatId ?? REAL_CHAT,
    chatType: "supergroup",
    chatTitle: "Valor Test Group",
    sender: o.senderId ? { id: o.senderId, username: o.username, firstName: "T", isBot: false } : undefined,
    messageId: o.messageId,
    sentAt: new Date(1759000000 * 1000),
    text: o.text,
    raw: {},
  };
}

async function unitTests() {
  check("extractUrls", extractUrls("see http://evil.example/a and https://ok.org/b").length === 2);
  check("domainOf", domainOf("http://sub.evil.example/x") === "sub.evil.example");
  check("matchDomain parent", matchDomain(["http://sub.evil.example/x"], ["evil.example"]) === "evil.example");
  check("matchDomain miss", matchDomain(["https://ok.org/"], ["evil.example"]) === undefined);
  check("detectRepeat", detectRepeat(["a", "b", "a", "a"], 3) === true);
  check("detectRepeat negative", detectRepeat(["a", "b", "c"], 3) === false);
  check("detectFlood", detectFlood(10, 10) === true && detectFlood(9, 10) === false);
  check("isControlCommand", isControlCommand("/connect@Bot ABC") && !isControlCommand("hello"));
  check("listTools six", listTools().length === 6, listTools());
  let threw: unknown = null;
  try {
    await executeTool("banUser", {} as never);
  } catch (e) {
    threw = e;
  }
  check("unregistered tool throws", threw instanceof ToolNotRegisteredError);
  check(
    "decision validation rejects unknown tool",
    validateDecision({ classification: "SPAM", confidence: 1, rationale: "x", proposedActions: [{ tool: "nuke", args: {} }] }).ok === false,
  );
}

async function main() {
  await unitTests();

  const [community] = await db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.name, "Wizard Test Community"))
    .limit(1);
  if (!community) throw new Error("Wizard Test Community missing — connect Telegram and send a message first");
  const communityId = community.id;
  const startedAt = new Date();
  const runId = randomUUID().slice(0, 8);

  // fixtures: tester member, policy with blocked domain, synthetic messages
  const [tester] = await db
    .insert(members)
    .values({ communityId, telegramUserId: `91${runId.replace(/-/g, "").slice(0, 6)}`, username: "p3tester", firstName: "P3", role: "member" })
    .returning({ id: members.id, telegramUserId: members.telegramUserId });
  if (!tester.telegramUserId) throw new Error("fixture member insert failed");
  const testerTg: string = tester.telegramUserId;
  const [policy] = await db
    .insert(policies)
    .values({ communityId, name: "p3-test", rules: { blockedDomains: ["evil.example"], allowlistedDomains: ["docs.example"] }, isActive: true })
    .returning({ id: policies.id });

  const tgBase = 913000 + Math.floor(Math.random() * 1000);
  async function fixtureMsg(tgId: number, senderTg: string, text: string) {
    const mem = senderTg === testerTg ? tester.id : null;
    const [row] = await db
      .insert(messages)
      .values({ communityId, memberId: mem, telegramMessageId: String(tgId), text, kind: "text", sentAt: new Date(1759000000 * 1000) })
      .returning({ id: messages.id });
    return row.id;
  }
  const cycleIds: string[] = [];
  const track = <T extends { cycleId: string }>(r: T): T => { cycleIds.push(r.cycleId); return r; };

  try {
    // 1. REAL message replay (live row tgId 205)
    {
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900001, messageId: 205, senderId: REAL_ADMIN_TG, text: "hello communityos test" }),
        { client: stubClient(calls) },
      ));
      check("replay real msg completes", r.status === "completed", r.status);
      check("replay context community", r.decision?.classification === "NORMAL");
      check("replay no actions", (r.results ?? []).length === 0, r.results);
      check("replay no telegram calls", calls.length === 0, calls);
      const logs = await db.select().from(activityLogs)
        .where(and(eq(activityLogs.communityId, communityId), sql`detail->>'cycleId' = ${r.cycleId}`));
      check("replay logged", logs.some((l) => l.event === "agent.cycle_completed"), logs.map((l) => l.event));
    }

    // 2. SPAM with corroboration -> delete executes, result persisted
    {
      const tgId = tgBase + 1;
      await fixtureMsg(tgId, testerTg, "buy now [spam-test] http://evil.example/offer");
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900002, messageId: tgId, senderId: testerTg, text: "buy now [spam-test] http://evil.example/offer" }),
        { client: stubClient(calls) },
      ));
      const del = calls.find((c) => c.method === "deleteMessage");
      check("spam delete executed", r.status === "completed" && !!del, { r: r.status, calls });
      check("spam delete targets event ids", del?.chatId === -1003320389084 && del?.messageId === tgId, del);
      const acts = await db.select().from(agentActions)
        .where(and(eq(agentActions.communityId, communityId), sql`detail->>'cycleId' = ${r.cycleId}`));
      check("spam action persisted", acts.length === 1 && acts[0].status === "executed" && acts[0].kind === "delete_message", acts);
      check("spam structured decision", r.decision?.classification === "SPAM" && (r.policy ?? []).length === 1, r.decision);
    }

    // 3. PHISHING -> delete executes, restrict queued (NOT executed), alert created
    {
      const tgId = tgBase + 2;
      await fixtureMsg(tgId, testerTg, "verify wallet [phish-test] http://evil.example/login");
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900003, messageId: tgId, senderId: testerTg, text: "verify wallet [phish-test] http://evil.example/login" }),
        { client: stubClient(calls) },
      ));
      check("phish delete executed", calls.some((c) => c.method === "deleteMessage"));
      check("phish restrict NOT executed", !calls.some((c) => c.method === "restrictUser"), calls);
      const byTool = Object.fromEntries((r.results ?? []).map((x) => [x.tool, x.status]));
      check("phish gating", byTool.delete_message === "executed" && byTool.restrict_user === "approval_pending" && byTool.create_alert === "executed", byTool);
      const appr = await db.select().from(approvals)
        .where(and(eq(approvals.communityId, communityId), eq(approvals.status, "pending"), sql`detail->>'cycleId' = ${r.cycleId}`));
      check("phish approval queued", appr.length === 1 && appr[0].kind === "restrict_user", appr);
      const al = await db.select().from(alerts)
        .where(and(eq(alerts.communityId, communityId), sql`id in (select (detail->>'alertId')::uuid from agent_actions where detail->>'cycleId' = ${r.cycleId})`));
      check("phish alert created", al.length === 1 && al[0].severity === "high", al);
    }

    // 4. ESCALATE -> alert only, zero Telegram mutations
    {
      const tgId = tgBase + 3;
      await fixtureMsg(tgId, testerTg, "mods check this [escalate-test]");
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900004, messageId: tgId, senderId: testerTg, text: "mods check this [escalate-test]" }),
        { client: stubClient(calls) },
      ));
      check("escalate alert only", r.status === "completed" && calls.length === 0, { r: r.status, calls });
      check("escalate result", r.results?.[0]?.tool === "escalate" && r.results?.[0]?.status === "executed", r.results);
    }

    // 5. SUPPORT -> escalated to queue, no auto-reply
    {
      const tgId = tgBase + 4;
      await fixtureMsg(tgId, testerTg, "how do withdrawals work [support-test]");
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900005, messageId: tgId, senderId: testerTg, text: "how do withdrawals work [support-test]" }),
        { client: stubClient(calls) },
      ));
      check("support escalated", r.decision?.classification === "SUPPORT" && calls.length === 0, { d: r.decision, calls });
    }

    // 6. Admin immunity: linked admin posts spam-like text -> DENY, no delete
    {
      const tgId = tgBase + 5;
      await fixtureMsg(tgId, REAL_ADMIN_TG, "pinned links [spam-test] http://evil.example/x");
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900006, messageId: tgId, senderId: REAL_ADMIN_TG, text: "pinned links [spam-test] http://evil.example/x" }),
        { client: stubClient(calls) },
      ));
      check("admin delete refused", r.results?.[0]?.status === "skipped" && !calls.some((c) => c.method === "deleteMessage"), { r: r.results, calls });
    }

    // 7. Rogue tool rejected, nothing executed
    {
      const tgId = tgBase + 6;
      await fixtureMsg(tgId, testerTg, "rogue");
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900007, messageId: tgId, senderId: testerTg, text: "rogue" }),
        { client: stubClient(calls), provider: rogueProvider },
      ));
      check("rogue rejected", r.status === "rejected" && calls.length === 0, r);
    }

    // 8. Malformed decision rejected, nothing executed
    {
      const tgId = tgBase + 7;
      await fixtureMsg(tgId, testerTg, "garbage");
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900008, messageId: tgId, senderId: testerTg, text: "garbage" }),
        { client: stubClient(calls), provider: garbageProvider },
      ));
      check("malformed rejected", r.status === "rejected" && r.reason === "malformed_decision" && calls.length === 0, r);
    }

    // 9. Telegram API failure -> failed result persisted, honestly logged
    {
      const tgId = tgBase + 8;
      await fixtureMsg(tgId, testerTg, "again [spam-test] http://evil.example/y");
      const calls: Call[] = [];
      const r = track(await runAgentCycle(
        msgEvent({ updateId: 900009, messageId: tgId, senderId: testerTg, text: "again [spam-test] http://evil.example/y" }),
        { client: stubClient(calls, { method: "deleteMessage", error: "telegram 400 Bad Request" }) },
      ));
      check("tg failure captured", r.results?.[0]?.status === "failed" && r.results?.[0]?.error === "telegram 400 Bad Request", r.results);
      const acts = await db.select().from(agentActions)
        .where(and(eq(agentActions.communityId, communityId), sql`detail->>'cycleId' = ${r.cycleId}`));
      check("tg failure persisted as failed", acts.length === 1 && acts[0].status === "failed", acts);
    }

    // 10. DB failure -> cycle fails, zero Telegram calls
    {
      const calls: Call[] = [];
      const r = await runAgentCycle(
        msgEvent({ updateId: 900010, messageId: 205, senderId: testerTg, text: "x" }),
        { client: stubClient(calls), store: throwingStore },
      );
      check("db failure contained", r.status === "failed" && calls.length === 0, r);
    }

    // 11. Unknown community -> failed, zero Telegram calls
    {
      const calls: Call[] = [];
      const r = await runAgentCycle(
        msgEvent({ updateId: 900011, messageId: 1, senderId: "1", text: "x", chatId: "-1000000001" }),
        { client: stubClient(calls) },
      );
      check("unknown community failed", r.status === "failed" && calls.length === 0, r);
    }

    // 12. Control command skipped
    {
      const calls: Call[] = [];
      const r = await runAgentCycle(
        msgEvent({ updateId: 900012, senderId: testerTg, text: "/connect ABC123" }),
        { client: stubClient(calls) },
      );
      check("control skipped", r.status === "skipped" && calls.length === 0, r);
    }

    // 13. Non-message kind skipped
    {
      const calls: Call[] = [];
      const r = await runAgentCycle(
        { ...msgEvent({ updateId: 900013, senderId: testerTg, text: "x" }), kind: "callback_query" },
        { client: stubClient(calls) },
      );
      check("callback kind skipped", r.status === "skipped", r);
    }
  } finally {
    // cleanup: fixtures + everything tagged with our cycleIds
    for (const cid of cycleIds) {
      await db.delete(agentActions).where(sql`detail->>'cycleId' = ${cid}`);
      await db.delete(approvals).where(sql`detail->>'cycleId' = ${cid}`);
    }
    await db.delete(alerts).where(and(eq(alerts.communityId, communityId), gte(alerts.createdAt, startedAt)));
    await db.delete(activityLogs).where(and(eq(activityLogs.communityId, communityId), gte(activityLogs.createdAt, startedAt)));
    await db.delete(messages).where(and(eq(messages.communityId, communityId), gte(messages.createdAt, startedAt)));
    await db.delete(members).where(eq(members.id, tester.id));
    await db.delete(policies).where(eq(policies.id, policy.id));
    const left = await db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.communityId, communityId), gte(messages.createdAt, startedAt)));
    const leftA = await db.select({ id: agentActions.id }).from(agentActions)
      .where(and(eq(agentActions.communityId, communityId), gte(agentActions.createdAt, startedAt)));
    check("cleanup complete", left.length === 0 && leftA.length === 0, { left: left.length, leftA: leftA.length });
  }

  console.log(`\nTOTAL passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
