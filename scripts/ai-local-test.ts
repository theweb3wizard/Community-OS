import "../src/db/load-env";

import { and, eq, sql } from "drizzle-orm";

import { db } from "../src/db";
import { activityLogs } from "../src/db/schema";
import { runAgentCycle } from "../src/lib/agent/runtime";

import type { AgentContext } from "../src/lib/agent/types";
import { decisionToActions } from "../src/lib/ai/actions";
import { mapJevAnswers } from "../src/lib/ai/jev";
import { chunkText, fetchUrlText } from "../src/lib/ai/knowledge";
import { FallbackDecisionProvider, semanticGate } from "../src/lib/ai/providers";
import {
  validateStructuredDecision,
} from "../src/lib/ai/structured";

// Offline automated tests for Prompt 4 (no API keys, no network except
// fetchUrlText validation which fails before any request). Live provider
// tests run separately once GEMINI_API_KEY is available.

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

const baseContext = {
  cycleId: "test",
  community: { id: "c1", name: "Test", slug: "test" },
  recentMessages: [],
  policies: [],
  signals: {
    isAdmin: false,
    isControlCommand: false,
    urls: [],
    repeated: false,
    flooding: false,
  },
  event: {
    updateId: 1,
    kind: "message",
    chatId: "-1001",
    chatType: "supergroup",
    text: "hello everyone, how do withdrawals work here?",
    raw: {},
  },
} as unknown as AgentContext;

async function main() {
  // chunking
  const chunks = chunkText("Para one is here.\n\nPara two is here with more words to fill.");
  check("chunk accumulates short text", chunks.length === 1, chunks);
  const two = chunkText(`${"x".repeat(300)}\n\n${"y".repeat(300)}`, 500, 20);
  check("chunk splits at paragraph", two.length === 2, two.map((c) => c.length));
  check("chunk empty", chunkText("   ").length === 0);
  const long = `Start. ${"Sentence one here. ".repeat(60)}End.`;
  const split = chunkText(long, 200, 20);
  check("chunk splits oversized", split.length > 2 && split.every((c) => c.length <= 200), split.length);
  const overlap = chunkText(`${"a".repeat(400)}\n\n${"b".repeat(400)}`, 500, 50);
  check("chunk overlap bounded", overlap.length === 2 && overlap.every((c) => c.length <= 500));

  // structured validation
  const valid = {
    category: "SPAM", confidence: 0.9, urgency: 0.2, spamProbability: 0.88,
    scamProbability: 0.05, supportIntent: false, ruleViolation: true,
    recommendedAction: "delete", reasoningSummary: "bulk promo", requiresHuman: false,
    knowledgeRequired: false,
  };
  check("structured valid", validateStructuredDecision(valid).ok === true);
  check("structured bad enum", validateStructuredDecision({ ...valid, category: "MAYBE" }).ok === false);
  check("structured bad confidence", validateStructuredDecision({ ...valid, confidence: 2 }).ok === false);
  check("structured missing field", validateStructuredDecision({ ...valid, reasoningSummary: undefined }).ok === false);

  // action mapping covers every recommendation
  const acts: Record<string, string[]> = {};
  for (const rec of ["none", "delete", "restrict", "warn", "reply", "escalate", "alert"] as const) {
    acts[rec] = decisionToActions({ ...valid, category: "NORMAL", recommendedAction: rec }).map((a) => a.tool);
  }
  check("map none", acts.none.length === 0);
  check("map delete", acts.delete.join() === "delete_message");
  check("map restrict", acts.restrict.join() === "restrict_user");
  check("map warn", acts.warn.join() === "warn_user");
  check("map reply", acts.reply.join() === "send_reply");
  check("map escalate", acts.escalate.join() === "escalate");
  check("map alert", acts.alert.join() === "create_alert");

  // Jev mapping from the documented Decisions API answer shape
  const mapped = mapJevAnswers({
    category: { type: "choice", choice: "PHISHING", confidence: 0.91, probabilities: { NORMAL: 0.02, SPAM: 0.05, PHISHING: 0.9, SUPPORT: 0.02, ESCALATE: 0.01 } },
    needs_human: { type: "noul", noul: 0.82 },
    urgency: { type: "score", score: 2.4, confidence: 0.8, probabilities: {}, legend: {} },
  });
  check("jev category", mapped.category === "PHISHING");
  check("jev probs", mapped.scamProbability === 0.9 && mapped.spamProbability === 0.05);
  check("jev urgency normalized", Math.abs(mapped.urgency - 0.8) < 1e-9, mapped.urgency);
  check("jev requiresHuman", mapped.requiresHuman === true);
  check("jev summary mentions choice", mapped.reasoningSummary.includes("PHISHING"));
  check("jev structured validates", validateStructuredDecision(mapped).ok === true);
  let jevBad = false;
  try {
    mapJevAnswers({
      category: { type: "choice", choice: "WEIRD" },
      needs_human: { type: "noul", noul: 0.1 },
      urgency: { type: "score", score: 0 },
    });
  } catch {
    jevBad = true;
  }
  check("jev unknown category throws", jevBad);

  // semantic gate
  check("gate normal needed", semanticGate(baseContext).needed === true);
  check("gate control skipped", semanticGate({ ...baseContext, signals: { ...baseContext.signals, isControlCommand: true } }).reason === "control_command");
  check("gate trivial skipped", semanticGate({ ...baseContext, event: { ...baseContext.event, text: "hi" } }).reason === "trivial_text");
  check("gate bot skipped", semanticGate({ ...baseContext, event: { ...baseContext.event, sender: { id: "1", isBot: true } } }).reason === "bot_sender");
  check("gate callback skipped", semanticGate({ ...baseContext, event: { ...baseContext.event, kind: "callback_query" } }).needed === false);

  // fallback chain
  const boom = (name: string) => ({ name, decide: async () => { throw new Error(`${name}_down`); } });
  const good = (name: string) => ({ name, decide: async () => ({ classification: "NORMAL", confidence: 1, rationale: "ok", proposedActions: [] }) });
  const chain = new FallbackDecisionProvider(boom("jev") as never, good("gemini") as never);
  const d = await chain.decide(baseContext);
  check("fallback switches", chain.usedProvider === "gemini" && d.classification === "NORMAL", chain.usedProvider);
  const dead = new FallbackDecisionProvider(boom("jev") as never, boom("gemini") as never);
  let deadErr = "";
  try {
    await dead.decide(baseContext);
  } catch (e) {
    deadErr = e instanceof Error ? e.message : "";
  }
  check("total failure safe error", deadErr.includes("all_providers_failed") && deadErr.includes("jev_down") && deadErr.includes("gemini_down"), deadErr);
  const none = new FallbackDecisionProvider(null, null);
  let noneErr = "";
  try {
    await none.decide(baseContext);
  } catch (e) {
    noneErr = e instanceof Error ? e.message : "";
  }
  check("no providers configured", noneErr.includes("none configured"), noneErr);

  // url validation (no network — fails before any request)
  let urlErr = "";
  try {
    await fetchUrlText("not-a-url");
  } catch (e) {
    urlErr = e instanceof Error ? e.message : "";
  }
  check("bad url rejected", urlErr.includes("invalid url"), urlErr);
  let schemeErr = "";
  try {
    await fetchUrlText("ftp://example.com/x");
  } catch (e) {
    schemeErr = e instanceof Error ? e.message : "";
  }
  check("bad scheme rejected", schemeErr.includes("unsupported url scheme"), schemeErr);
  let ssrfErr = "";
  try {
    await fetchUrlText("http://169.254.169.254/latest/meta-data/");
  } catch (e) {
    ssrfErr = e instanceof Error ? e.message : "";
  }
  check("ssrf link-local blocked", ssrfErr.includes("non-public"), ssrfErr);
  let portErr = "";
  try {
    await fetchUrlText("https://example.com:8443/x");
  } catch (e) {
    portErr = e instanceof Error ? e.message : "";
  }
  check("nonstandard port blocked", portErr.includes("only default"), portErr);

  // runtime gate: trivial text never reaches a provider (Scenario A)
  let decideCalls = 0;
  const countingProvider = {
    name: "counter",
    decide: async () => {
      decideCalls++;
      return { classification: "NORMAL", confidence: 1, rationale: "x", proposedActions: [] };
    },
  };
  const gateEvent = {
    ...baseContext.event,
    updateId: 424242,
    chatId: "-1003320389084",
    text: "ok",
  };
  const gateResult = await runAgentCycle(
    gateEvent as never,
    { provider: countingProvider as never },
  );
  check(
    "gate skips provider",
    gateResult.status === "completed" && decideCalls === 0 && gateResult.decision?.classification === "NORMAL",
    { status: gateResult.status, decideCalls },
  );
  await db
    .delete(activityLogs)
    .where(and(eq(activityLogs.event, "agent.cycle_completed"), sql`detail->>'cycleId' = ${gateResult.cycleId}`));

  console.log(`\nTOTAL passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
