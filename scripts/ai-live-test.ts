// LIVE tests against real Gemini + Neon (requires GEMINI_API_KEY).
// Skips cleanly without a key. Creates a test knowledge source and support
// rows, then deletes everything. Run: npm run ai:live
import "../src/db/load-env";
import { and, eq, gte } from "drizzle-orm";

import { db } from "../src/db";
import {
  activityLogs,
  alerts,
  communities,
  knowledgeChunks,
  knowledgeSources,
  supportIssues,
} from "../src/db/schema";
import { GeminiClient } from "../src/lib/ai/gemini";
import { createSource, retrieveKnowledge } from "../src/lib/ai/knowledge";
import { FallbackDecisionProvider, GeminiDecisionProvider } from "../src/lib/ai/providers";
import { validateStructuredDecision } from "../src/lib/ai/structured";
import { answerSupport } from "../src/lib/ai/support";
import { getCommunitySignals, summarizeCommunity } from "../src/lib/ai/intelligence";

// LIVE tests against real Gemini + Neon. Creates a test knowledge source and
// support rows, then deletes everything. Prints exact outcomes.

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`LIVE_PASS ${name}`);
  } else {
    failed++;
    console.log(`LIVE_FAIL ${name} ${extra !== undefined ? JSON.stringify(extra) : ""}`);
  }
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log("SKIP ai:live (GEMINI_API_KEY not set)");
    return;
  }
  const startedAt = new Date();
  const [community] = await db
    .select({ id: communities.id, name: communities.name })
    .from(communities)
    .where(eq(communities.name, "Wizard Test Community"))
    .limit(1);
  if (!community) throw new Error("test community missing");
  const communityId = community.id;
  const client = GeminiClient.fromEnv();

  // 1. structured decision reaches Gemini and validates
  const raw = await client.generateStructured(
    `Classify this Telegram message. Message: "Hey everyone, quick question — how do withdrawals work here?" Signals: no urls, not repeated, not flooding, sender is a regular member.`,
    (await import("../src/lib/ai/structured")).STRUCTURED_DECISION_JSON_SCHEMA,
  );
  const v = validateStructuredDecision(raw);
  check("structured decision validates", v.ok === true, raw);
  if (v.ok) {
    console.log(`DECISION category=${v.decision.category} conf=${v.decision.confidence} action=${v.decision.recommendedAction} human=${v.decision.requiresHuman} knowledge=${v.decision.knowledgeRequired}`);
    console.log(`REASONING ${v.decision.reasoningSummary.slice(0, 200)}`);
  }

  // 2. provider-level decision (Gemini fallback path, Jev unconfigured)
  const chain = new FallbackDecisionProvider(null, new GeminiDecisionProvider(client));
  const ctx = {
    cycleId: "live", community: { id: communityId, name: community.name, slug: "x" },
    recentMessages: [], policies: [],
    signals: { isAdmin: false, isControlCommand: false, urls: [], repeated: false, flooding: false },
    event: { updateId: 1, kind: "message", chatId: "-1003320389084", chatType: "supergroup", messageId: 205, text: "hello communityos test", raw: {} },
  } as never;
  const d = await chain.decide(ctx);
  check("provider decision via gemini", chain.usedProvider === "gemini" && d.classification.length > 0, { used: chain.usedProvider, d });

  // 3. embeddings are 1536d
  const vecs = await client.embed(["withdrawals are processed twice daily", "be kind to moderators"], "RETRIEVAL_DOCUMENT");
  check("embeddings 1536d x2", vecs.length === 2 && vecs.every((x) => x.length === 1536), vecs.map((x) => x.length));

  // 4. knowledge ingest + retrieval with attribution
  const faq = [
    "Withdrawals: withdrawals are processed twice daily, at 08:00 and 20:00 UTC. Minimum withdrawal is 10 tokens. Contact a moderator if a withdrawal is delayed more than 24 hours.",
    "Deposits: deposits are credited automatically after 12 network confirmations. There is no minimum deposit. If a deposit does not appear within 2 hours, share your transaction hash with a moderator.",
    "Spam rule: posting the same promotional link three or more times results in message deletion. Repeated violations lead to temporary restriction after human review. Appeals go through the support queue.",
  ].join("\n\n");
  const { sourceId, chunks } = await createSource({ communityId, kind: "faq", title: "P4 Live FAQ", content: faq, client });
  console.log(`SOURCE id=${sourceId} chunks=${chunks}`);
  check("ingested chunks", chunks >= 2, chunks);
  const hits = await retrieveKnowledge(communityId, "when are withdrawals processed?", 4, 0.35, client);
  check("retrieval hits", hits.length > 0 && hits[0].sourceTitle === "P4 Live FAQ", hits.map((h) => ({ t: h.sourceTitle, s: h.similarity.toFixed(3) })));
  console.log(`TOP_HIT sim=${hits[0]?.similarity.toFixed(4)} text=${JSON.stringify(hits[0]?.content.slice(0, 120))}`);

  // 5. grounded support answer
  const a1 = await answerSupport(communityId, "When are withdrawals processed?", { client });
  check("grounded HIGH", a1.confidence === "HIGH" && a1.sources.length > 0, { c: a1.confidence, s: a1.sources });
  console.log(`ANSWER_HIGH ${a1.answer.slice(0, 300)}`);
  const groundedOk = /08:00|20:00|twice daily/i.test(a1.answer);
  check("answer uses trusted facts", groundedOk, a1.answer.slice(0, 300));

  // 6. ungrounded question escalates without invention
  const a2 = await answerSupport(communityId, "What is the token listing date on major exchanges?", { client });
  check("ungrounded escalates", a2.confidence === "LOW" && a2.supportIssueId !== null, { c: a2.confidence, a: a2.answer.slice(0, 120) });
  check("no fabricated specifics", !/\d{4}-\d{2}-\d{2}|January|February|March|April|May|June|July|August|September|October|November|December/i.test(a2.answer), a2.answer);

  // 7. Jev failure simulation -> Gemini fallback occurs
  process.env.JEV_API_KEY = "invalid-key-for-simulation";
  const { JevDecisionProvider } = await import("../src/lib/ai/providers");
  const chain2 = new FallbackDecisionProvider(new JevDecisionProvider(), new GeminiDecisionProvider(client));
  const d2 = await chain2.decide(ctx);
  check("jev failure falls back", chain2.usedProvider === "gemini" && d2.classification.length > 0, { used: chain2.usedProvider, c: d2.classification });
  delete process.env.JEV_API_KEY;

  // 8. total failure fails safely
  const badClient = GeminiClient.withApiKey("invalid-key");
  const chain3 = new FallbackDecisionProvider(null, new GeminiDecisionProvider(badClient));
  let totalErr = "";
  try {
    await chain3.decide(ctx);
  } catch (e) {
    totalErr = e instanceof Error ? e.message : "";
  }
  check("total failure safe", totalErr.includes("all_providers_failed"), totalErr.slice(0, 200));

  // 9. intelligence signals + summary (deterministic part always works)
  const signals = await getCommunitySignals(communityId);
  check("signals computed", signals.totals.messages >= 1 && signals.topTerms.length > 0, signals.totals);
  console.log(`SIGNALS terms=${JSON.stringify(signals.topTerms.slice(0, 5))} velocity_points=${signals.velocity.length}`);
  const summary = await summarizeCommunity(community.name, signals, client);
  check("summary generated", typeof summary === "string" && (summary?.length ?? 0) > 50, summary?.slice(0, 200));

  // cleanup
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
  await db.delete(knowledgeSources).where(eq(knowledgeSources.id, sourceId));
  await db.delete(supportIssues).where(and(eq(supportIssues.communityId, communityId), gte(supportIssues.createdAt, startedAt)));
  await db.delete(alerts).where(and(eq(alerts.communityId, communityId), gte(alerts.createdAt, startedAt)));
  await db.delete(activityLogs).where(and(eq(activityLogs.communityId, communityId), gte(activityLogs.createdAt, startedAt)));
  const left = await db.select({ id: knowledgeSources.id }).from(knowledgeSources).where(eq(knowledgeSources.id, sourceId));
  check("live cleanup", left.length === 0);

  console.log(`\nLIVE_TOTAL passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
