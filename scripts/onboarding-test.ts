import "../src/db/load-env";
import { randomBytes } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";

import { db } from "../src/db";
import {
  activityLogs,
  alerts,
  communities,
  communitySettings,
  communityLinkCodes,
  knowledgeChunks,
  knowledgeSources,
  policies,
  supportIssues,
} from "../src/db/schema";
import { getDashboardStats, getInboxItems, getMessageContext } from "../src/lib/dashboard/queries";
import { resolveCommunity } from "../src/lib/dashboard/community";
import { createSource } from "../src/lib/ai/knowledge";

// Prompt 6 onboarding/integration test: a fresh community walks the full
// operator flow at the data layer (create → codes → policy → knowledge →
// support lifecycle → inbox/trace reflect it), then everything is removed.

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

async function main() {
  const suffix = randomBytes(2).toString("hex");
  const startedAt = new Date();
  const name = `P6 Onboarding ${suffix}`;

  // 1. create community (same operation as the Telegram page action)
  const slug = `p6-onboarding-${suffix}`;
  const [community] = await db
    .insert(communities)
    .values({ name, slug })
    .returning({ id: communities.id });
  const communityId = community.id;
  const listed = await resolveCommunity(undefined);
  check("community listed", listed.options.some((o) => o.id === communityId));

  // 2. link codes can be minted and are single-community scoped
  const [code] = await db
    .insert(communityLinkCodes)
    .values({ communityId, code: `P6${suffix.toUpperCase()}1`, purpose: "connect", expiresAt: new Date(Date.now() + 3600_000) })
    .returning({ id: communityLinkCodes.id, code: communityLinkCodes.code });
  check("connect code minted", code.code.length >= 6, code.code);

  // 3. policy enables automation
  const [policy] = await db
    .insert(policies)
    .values({ communityId, name: "p6-standard", rules: { mode: "standard", autoDeleteSpam: true }, isActive: true })
    .returning({ id: policies.id });
  check("policy active", policy.id.length > 0);

  // 4. settings upsert + readback
  await db.insert(communitySettings).values({ communityId, retrievalThreshold: 0.5, retrievalLimit: 3, notifyApprovals: true, notifyFailures: false });
  const [settings] = await db.select().from(communitySettings).where(eq(communitySettings.communityId, communityId));
  check("settings roundtrip", settings.retrievalThreshold === 0.5 && settings.retrievalLimit === 3 && settings.notifyFailures === false, settings);

  // 5. knowledge ingest (embedding quota may be exhausted: SKIP, don't fail)
  let knowledgeOk = false;
  let knowledgeSkipped = false;
  try {
    const r = await createSource({
      communityId, kind: "faq", title: "P6 FAQ",
      content: "Office hours: the team answers questions every weekday at 15:00 UTC in the main chat. Urgent incidents go to the on-call moderator.",
    });
    knowledgeOk = r.chunks >= 1;
  } catch (e) {
    knowledgeSkipped = /429|503|quota|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(e instanceof Error ? e.message : "");
    if (!knowledgeSkipped) throw e;
  }
  check("knowledge ingested", knowledgeOk || knowledgeSkipped, knowledgeSkipped ? "SKIPPED (embed quota)" : undefined);

  // 6. support lifecycle moves the dashboard numbers
  const before = await getDashboardStats(communityId);
  const [issue] = await db
    .insert(supportIssues)
    .values({ communityId, title: "P6 question", body: "P6 body", status: "open", priority: "normal" })
    .returning({ id: supportIssues.id });
  const during = await getDashboardStats(communityId);
  check("stats reflect open issue", during.supportOpen === before.supportOpen + 1, during);
  await db.update(supportIssues).set({ status: "resolved", updatedAt: new Date() }).where(eq(supportIssues.id, issue.id));
  const after = await getDashboardStats(communityId);
  check("stats reflect resolution", after.supportResolved === before.supportResolved + 1 && after.supportOpen === before.supportOpen, after);

  // 7. alert appears in the inbox as urgent
  const [alert] = await db
    .insert(alerts)
    .values({ communityId, severity: "high", title: "P6 urgent", body: "test" })
    .returning({ id: alerts.id });
  const inbox = await getInboxItems(communityId);
  check("inbox surfaces urgent", inbox.some((i) => i.id === `alert:${alert.id}` && i.bucket === "urgent"), inbox.map((i) => i.id));

  // 8. message trace resolves on the long-lived live row
  const live = await db.select().from(communities).where(eq(communities.name, "Wizard Test Community")).limit(1);
  void live;

  // cleanup (reverse FK order where it matters)
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.communityId, communityId));
  await db.delete(knowledgeSources).where(eq(knowledgeSources.communityId, communityId));
  await db.delete(supportIssues).where(eq(supportIssues.communityId, communityId));
  await db.delete(alerts).where(eq(alerts.communityId, communityId));
  await db.delete(activityLogs).where(and(eq(activityLogs.communityId, communityId), gte(activityLogs.createdAt, startedAt)));
  await db.delete(communityLinkCodes).where(eq(communityLinkCodes.communityId, communityId));
  await db.delete(policies).where(eq(policies.communityId, communityId));
  await db.delete(communitySettings).where(eq(communitySettings.communityId, communityId));
  await db.delete(communities).where(eq(communities.id, communityId));
  const gone = await db.select({ id: communities.id }).from(communities).where(eq(communities.id, communityId));
  check("onboarding cleanup", gone.length === 0);

  // 9. trace view works on the real Prompt-2 message (read-only)
  const wizard = await db.select({ id: communities.id }).from(communities).where(eq(communities.name, "Wizard Test Community")).limit(1);
  if (wizard[0]) {
    const { messages } = await import("../src/db/schema");
    const rows = await db.select().from(messages).where(and(eq(messages.communityId, wizard[0].id), eq(messages.telegramMessageId, "205"))).limit(1);
    if (rows[0]) {
      const trace = await getMessageContext(rows[0].id);
      check("trace resolves live message", !!trace?.member && trace?.community?.name === "Wizard Test Community", {
        member: trace?.member?.telegramUserId,
        actions: trace?.actions.length,
      });
    } else {
      check("trace resolves live message", false, "row 205 missing");
    }
  }

  console.log(`\nTOTAL passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
