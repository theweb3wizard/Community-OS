import "../src/db/load-env";
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
import { decideApproval } from "../src/lib/approvals/service";
import { runAgentCycle } from "../src/lib/agent/runtime";
import type { DecisionProvider } from "../src/lib/agent/provider";
import { runPipeline } from "../src/lib/telegram/pipeline";
import type { TelegramClient } from "../src/lib/telegram/client";
import type { NormalizedEvent } from "../src/lib/telegram/normalize";

// Policy + approval integration tests: policy verdicts, approval lifecycle over real
// Telegram-shaped callback events, idempotency, auth, human-only, failure.
// Telegram is stubbed; Neon is real. Full cleanup afterwards.

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
    getMe: async () => ({ id: 999888777, is_bot: false, first_name: "T", username: "t" }),
    sendMessage: async (chatId: unknown, text: unknown) => {
      calls.push({ method: "sendMessage", chatId, text });
      maybeFail("sendMessage");
      return { message_id: 991, date: 1, chat: { id: 1, type: "private" } };
    },
    reply: async (chatId: unknown, messageId: unknown, text: unknown) => {
      calls.push({ method: "reply", chatId, messageId, text });
      return { message_id: 992, date: 1, chat: { id: 1, type: "group" } };
    },
    deleteMessage: async (chatId: unknown, messageId: unknown) => {
      calls.push({ method: "deleteMessage", chatId, messageId });
      maybeFail("deleteMessage");
      return true;
    },
    restrictUser: async (chatId: unknown, userId: unknown) => {
      calls.push({ method: "restrictUser", chatId, userId });
      maybeFail("restrictUser");
      return true;
    },
    answerCallbackQuery: async (id: unknown, opts: unknown) => {
      calls.push({ method: "answerCallbackQuery", id, opts });
      return true;
    },
    editMessage: async (chatId: unknown, messageId: unknown, text: unknown) => {
      calls.push({ method: "editMessage", chatId, messageId, text });
      return { message_id: 994, date: 1, chat: { id: 1, type: "private" } };
    },
    sendAdminNotification: async (adminId: unknown, title: unknown, body: unknown, buttons: unknown) => {
      calls.push({ method: "sendAdminNotification", adminId, title, buttons });
      return { message_id: 993, date: 1, chat: { id: 1, type: "private" } };
    },
  };
  return stub as unknown as TelegramClient;
}

const REAL_CHAT = "-1003320389084";
const REAL_ADMIN = "7651409015";
const DM_CHAT = "7651409015";
// Per-run jitter so reruns never collide with previously claimed update_ids.
const UID_JITTER = Math.floor(Math.random() * 5000);

function msgEvent(o: { updateId: number; messageId: number; senderId: string; text: string }): NormalizedEvent {
  return {
    updateId: o.updateId + UID_JITTER, kind: "message", chatId: REAL_CHAT, chatType: "supergroup",
    chatTitle: "Valor Test Group",
    sender: { id: o.senderId, username: "t", firstName: "T", isBot: false },
    messageId: o.messageId, sentAt: new Date(1759000000 * 1000), text: o.text, raw: {},
  };
}

function callbackEvent(updateId: number, data: string, fromId: string): NormalizedEvent {
  return {
    updateId: updateId + UID_JITTER, kind: "callback_query", chatId: DM_CHAT, chatType: "private",
    sender: { id: fromId, username: "admin", firstName: "A", isBot: false },
    messageId: 42, callbackId: `cq-${updateId}`, callbackData: data, raw: {},
  };
}

const humanOnlyProvider = {
  name: "human-only",
  decide: async () => ({
    classification: "SPAM", confidence: 0.95, rationale: "test", requiresHuman: true,
    proposedActions: [{ tool: "delete_message", args: {} }],
  }),
} as unknown as DecisionProvider;

const normalDeleteProvider = {
  name: "normal-delete",
  decide: async () => ({
    classification: "NORMAL", confidence: 0.9, rationale: "test",
    proposedActions: [{ tool: "delete_message", args: {} }],
  }),
} as unknown as DecisionProvider;

async function main() {
  const [community] = await db.select({ id: communities.id }).from(communities)
    .where(eq(communities.name, "Wizard Test Community")).limit(1);
  if (!community) throw new Error("test community missing");
  const communityId = community.id;
  const startedAt = new Date();
  const cycleIds: string[] = [];
  const tgBase = 914000 + Math.floor(Math.random() * 500);
  let strictPolicyId = "";

  const [tester] = await db.insert(members).values({
    // Numeric string: real Telegram user IDs are integers and the Telegram
    // API requires Integer user_id for restrictions.
    communityId, telegramUserId: `921${String(Math.floor(Math.random() * 900) + 100)}`,
    username: "p5tester", firstName: "P5", role: "member",
  }).returning({ id: members.id, telegramUserId: members.telegramUserId });
  if (!tester.telegramUserId) throw new Error("fixture failed");
  const testerTg: string = tester.telegramUserId;
  // Corroboration fixture: evil.example is a known-bad domain here, so
  // high-confidence spam/phishing with these links qualifies for AUTO.
  const [blockPolicy] = await db.insert(policies).values({
    communityId, name: "p5-blocklist", rules: { blockedDomains: ["evil.example"] }, isActive: true,
  }).returning({ id: policies.id });

  async function fixtureMsg(tgId: number, text: string) {
    await db.insert(messages).values({
      communityId, memberId: tester.id, telegramMessageId: String(tgId),
      text, kind: "text", sentAt: new Date(1759000000 * 1000),
    });
  }

  try {
    // 1. AUTO: corroborated spam deletes immediately, no approval row
    {
      const tgId = tgBase + 1;
      await fixtureMsg(tgId, "buy now [spam-test] http://evil.example/offer");
      const calls: Call[] = [];
      const r = await runAgentCycle(msgEvent({ updateId: 910001, messageId: tgId, senderId: testerTg, text: "buy now [spam-test] http://evil.example/offer" }), { client: stubClient(calls) });
      cycleIds.push(r.cycleId);
      check("auto verdict", r.policy?.[0]?.verdict === "AUTO_EXECUTE", r.policy);
      check("auto executed", calls.some((c) => c.method === "deleteMessage"));
      check("auto no approval", !calls.some((c) => c.method === "sendAdminNotification"), calls.map((c) => c.method));
      const appr = await db.select().from(approvals).where(sql`detail->>'cycleId' = ${r.cycleId}`);
      check("auto no approval row", appr.length === 0);
    }

    // 2. APPROVAL: phishing restrict queues + DM with working-shaped buttons
    let token = "";
    {
      const tgId = tgBase + 2;
      await fixtureMsg(tgId, "verify wallet [phish-test] http://evil.example/login");
      const calls: Call[] = [];
      const r = await runAgentCycle(msgEvent({ updateId: 910002, messageId: tgId, senderId: testerTg, text: "verify wallet [phish-test] http://evil.example/login" }), { client: stubClient(calls) });
      cycleIds.push(r.cycleId);
      const dm = calls.find((c) => c.method === "sendAdminNotification");
      check("approval DM sent", !!dm && dm.adminId === REAL_ADMIN, dm);
      const buttons = ((dm?.buttons ?? []) as Array<{ data?: string }>).map((b) => b.data ?? "");
      check("DM buttons carry tokens", buttons.some((d) => d.startsWith("ap:")) && buttons.some((d) => d.startsWith("rj:")), buttons);
      token = (buttons.find((d) => d.startsWith("ap:")) ?? "").slice(3);
      check("DM to linked admin only", dm?.adminId === REAL_ADMIN);
      const appr = await db.select().from(approvals).where(sql`detail->>'cycleId' = ${r.cycleId}`);
      check("approval row pending with evidence", appr.length === 1 && appr[0].status === "pending" && !!(appr[0].detail as Record<string, unknown>).callbackToken, appr[0]);
      check("restrict not yet executed", !calls.some((c) => c.method === "restrictUser"));
    }

    // 3. APPROVE via Telegram callback: executes once, edits DM, answers
    {
      const calls: Call[] = [];
      const o = await runPipeline(callbackEvent(910003, `ap:${token}`, REAL_ADMIN), { client: stubClient(calls) });
      check("approve outcome", o.detail === "approval_approved_executed", o);
      const restricts = calls.filter((c) => c.method === "restrictUser");
      check("restrict executed once", restricts.length === 1, restricts);
      check("restrict targets event ids", String(restricts[0]?.chatId) === REAL_CHAT && String(restricts[0]?.userId) === testerTg, restricts[0]);
      check("DM edited", calls.some((c) => c.method === "editMessage"));
      check("callback answered", calls.some((c) => c.method === "answerCallbackQuery"));
      const appr = await db.select().from(approvals).where(sql`detail->>'callbackToken' = ${token}`);
      check("approval approved", appr[0]?.status === "approved", appr[0]?.status);
    }

    // 4. DUPLICATE decision (new delivery, same approval): already decided,
    // execution must NOT repeat. (Same update_id would hit repeat-delivery
    // dedupe instead — that path is covered by the telegram suite.)
    {
      const calls: Call[] = [];
      const o = await runPipeline(callbackEvent(910104, `ap:${token}`, REAL_ADMIN), { client: stubClient(calls) });
      check("duplicate already_decided", o.detail === "approval_already_decided", o);
      check("no second execution", !calls.some((c) => c.method === "restrictUser"), calls.map((c) => c.method));
    }

    // 5. REJECT: no Telegram mutation, status rejected, logged
    {
      const tgId = tgBase + 3;
      await fixtureMsg(tgId, "another lure [phish-test] http://evil.example/x");
      const c1: Call[] = [];
      const r = await runAgentCycle(msgEvent({ updateId: 910005, messageId: tgId, senderId: testerTg, text: "another lure [phish-test] http://evil.example/x" }), { client: stubClient(c1) });
      cycleIds.push(r.cycleId);
      const appr = await db.select().from(approvals).where(sql`detail->>'cycleId' = ${r.cycleId}`);
      const rtoken = ((appr[0].detail as Record<string, unknown>).callbackToken as string) ?? "";
      const calls: Call[] = [];
      const o = await runPipeline(callbackEvent(910006, `rj:${rtoken}`, REAL_ADMIN), { client: stubClient(calls) });
      check("reject outcome", o.detail === "approval_rejected", o);
      check("reject no mutation", !calls.some((c) => c.method === "restrictUser" || c.method === "deleteMessage"), calls.map((c) => c.method));
      const after = await db.select().from(approvals).where(eq(approvals.id, appr[0].id));
      check("rejected status", after[0].status === "rejected", after[0].status);
      const denied = await db.select().from(agentActions).where(
        and(eq(agentActions.communityId, communityId), sql`detail->>'approvalId' = ${appr[0].id}`),
      );
      check("rejection recorded", denied.some((a) => a.status === "denied"), denied.map((a) => a.status));
    }

    // 6. UNAUTHORIZED account: rejected, nothing executed, security logged
    {
      const tgId = tgBase + 4;
      await fixtureMsg(tgId, "third lure [phish-test] http://evil.example/y");
      const c1: Call[] = [];
      const r = await runAgentCycle(msgEvent({ updateId: 910007, messageId: tgId, senderId: testerTg, text: "third lure [phish-test] http://evil.example/y" }), { client: stubClient(c1) });
      cycleIds.push(r.cycleId);
      const appr = await db.select().from(approvals).where(sql`detail->>'cycleId' = ${r.cycleId}`);
      const rtoken = ((appr[0].detail as Record<string, unknown>).callbackToken as string) ?? "";
      const calls: Call[] = [];
      const o = await runPipeline(callbackEvent(910008, `ap:${rtoken}`, "999000111"), { client: stubClient(calls) });
      check("unauthorized blocked", o.detail === "approval_unauthorized", o);
      check("unauthorized no execution", !calls.some((c) => c.method === "restrictUser"), calls.map((c) => c.method));
      const still = await db.select().from(approvals).where(eq(approvals.id, appr[0].id));
      check("still pending", still[0].status === "pending", still[0].status);
      const sec = await db.select().from(activityLogs).where(
        and(eq(activityLogs.communityId, communityId), eq(activityLogs.event, "telegram.approval_unauthorized")),
      );
      check("security event logged", sec.length >= 1, sec.length);
      // approve for real afterwards so cleanup has no pending rows
      const c2: Call[] = [];
      await runPipeline(callbackEvent(910009, `rj:${rtoken}`, REAL_ADMIN), { client: stubClient(c2) });
    }

    // 7. HUMAN-ONLY: requiresHuman delete escalates, never executes
    {
      const tgId = tgBase + 5;
      await fixtureMsg(tgId, "funds post");
      const calls: Call[] = [];
      const r = await runAgentCycle(
        msgEvent({ updateId: 910010, messageId: tgId, senderId: testerTg, text: "funds post" }),
        { client: stubClient(calls), provider: humanOnlyProvider },
      );
      cycleIds.push(r.cycleId);
      check("human-only escalates", r.policy?.[0]?.verdict === "ESCALATE", r.policy);
      check("human-only no delete", !calls.some((c) => c.method === "deleteMessage"), calls.map((c) => c.method));
      check("escalation alert", r.results?.some((x) => x.tool === "escalate" && x.status === "executed") === true, r.results);
    }

    // 8. Treasury keyword forces human-only even for plain spam
    {
      const tgId = tgBase + 6;
      await fixtureMsg(tgId, "move treasury funds vote [spam-test] http://evil.example/z");
      const calls: Call[] = [];
      const r = await runAgentCycle(
        msgEvent({ updateId: 910011, messageId: tgId, senderId: testerTg, text: "move treasury funds vote [spam-test] http://evil.example/z" }),
        { client: stubClient(calls) },
      );
      cycleIds.push(r.cycleId);
      check("keyword escalates", r.policy?.[0]?.verdict === "ESCALATE" && !calls.some((c) => c.method === "deleteMessage"), { p: r.policy, c: calls.map((x) => x.method) });
    }

    // 9. IGNORE: normal text proposing deletion is dropped
    {
      const tgId = tgBase + 7;
      await fixtureMsg(tgId, "nice day");
      const calls: Call[] = [];
      const r = await runAgentCycle(
        msgEvent({ updateId: 910012, messageId: tgId, senderId: testerTg, text: "nice day" }),
        { client: stubClient(calls), provider: normalDeleteProvider },
      );
      cycleIds.push(r.cycleId);
      check("normal delete ignored", r.policy?.[0]?.verdict === "IGNORE" && calls.length === 0, { p: r.policy, c: calls });
    }

    // 10. STRICT community mode: corroborated spam still needs approval
    {
      const [p] = await db.insert(policies).values({
        communityId, name: "p5-strict", rules: { mode: "strict" }, isActive: true,
      }).returning({ id: policies.id });
      strictPolicyId = p.id;
      const tgId = tgBase + 8;
      await fixtureMsg(tgId, "strict spam [spam-test] http://evil.example/s");
      const calls: Call[] = [];
      const r = await runAgentCycle(
        msgEvent({ updateId: 910013, messageId: tgId, senderId: testerTg, text: "strict spam [spam-test] http://evil.example/s" }),
        { client: stubClient(calls) },
      );
      cycleIds.push(r.cycleId);
      check("strict forces approval", r.policy?.[0]?.verdict === "NEEDS_APPROVAL" && !calls.some((c) => c.method === "deleteMessage"), { p: r.policy, c: calls.map((x) => x.method) });
      await db.delete(policies).where(eq(policies.id, strictPolicyId));
      strictPolicyId = "";
    }

    // 11. FAILURE: approved restrict throws -> failed, honest, admin notified
    {
      const tgId = tgBase + 9;
      await fixtureMsg(tgId, "fail lure [phish-test] http://evil.example/f");
      const c1: Call[] = [];
      const r = await runAgentCycle(msgEvent({ updateId: 910014, messageId: tgId, senderId: testerTg, text: "fail lure [phish-test] http://evil.example/f" }), { client: stubClient(c1) });
      cycleIds.push(r.cycleId);
      const appr = await db.select().from(approvals).where(sql`detail->>'cycleId' = ${r.cycleId} and kind = 'restrict_user'`);
      check("failure approval exists", appr.length === 1, appr.length);
      const rtoken = ((appr[0].detail as Record<string, unknown>).callbackToken as string) ?? "";
      const failCalls: Call[] = [];
      const res = await decideApproval({
        byToken: rtoken, choice: "approve",
        actor: { kind: "telegram", telegramUserId: REAL_ADMIN },
        client: stubClient(failCalls, { method: "restrictUser", error: "telegram 400 Bad Request" }),
      });
      check("failure outcome", res.outcome === "approved_failed" && (res.error ?? "").includes("400"), res);
      check("admin told of failure", failCalls.some((c) => c.method === "sendMessage" && String(c.text).includes("FAILED")), failCalls.map((c) => c.method));
      const after = await db.select().from(approvals).where(eq(approvals.id, appr[0].id));
      check("failed status honest", after[0].status === "failed", after[0].status);
      const acts = await db.select().from(agentActions).where(sql`detail->>'approvalId' = ${appr[0].id}`);
      check("failed action persisted", acts.some((a) => a.status === "failed"), acts.map((a) => a.status));
    }

    // 12. Unknown token callback: acked safely, nothing happens
    {
      const calls: Call[] = [];
      const o = await runPipeline(callbackEvent(910015, "ap:FORGEDTOKEN123456", REAL_ADMIN), { client: stubClient(calls) });
      check("forged token safe", o.detail === "approval_not_found" && calls.some((c) => c.method === "answerCallbackQuery") && !calls.some((c) => c.method === "restrictUser"), o);
    }
  } finally {
    for (const cid of cycleIds) {
      await db.delete(agentActions).where(sql`detail->>'cycleId' = ${cid}`);
      await db.delete(approvals).where(sql`detail->>'cycleId' = ${cid}`);
    }
    await db.delete(alerts).where(and(eq(alerts.communityId, communityId), gte(alerts.createdAt, startedAt)));
    await db.delete(activityLogs).where(and(eq(activityLogs.communityId, communityId), gte(activityLogs.createdAt, startedAt)));
    await db.delete(messages).where(and(eq(messages.communityId, communityId), gte(messages.createdAt, startedAt)));
    await db.delete(members).where(eq(members.id, tester.id));
    await db.delete(policies).where(eq(policies.id, blockPolicy.id));
    // Safety net: remove any stray test policies if an earlier run crashed.
    await db.delete(policies).where(and(eq(policies.communityId, communityId), sql`${policies.name} like 'p5-%'`));
    if (strictPolicyId) await db.delete(policies).where(eq(policies.id, strictPolicyId));
    const left = await db.select({ id: approvals.id }).from(approvals)
      .where(and(eq(approvals.communityId, communityId), gte(approvals.createdAt, startedAt)));
    check("cleanup complete", left.length === 0, left.length);
  }

  console.log(`\nTOTAL passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
