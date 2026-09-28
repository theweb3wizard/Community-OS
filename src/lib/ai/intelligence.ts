import { and, desc, eq, gte } from "drizzle-orm";

import { db } from "@/db";
import { alerts, members, messages, moderationEvents, supportIssues } from "@/db/schema";
import { GeminiClient } from "./gemini";

// Operational community signals — deterministic aggregations, not scientific
// measurements. Computed on demand over a bounded recent window; an optional
// Gemini summary turns them into prose for operators (safe-fails to null).

const STOPWORDS = new Set(
  "the,a,an,and,or,but,if,then,else,for,to,of,in,on,at,is,are,was,were,be,been,this,that,these,those,with,from,have,has,had,you,your,we,our,they,their,not,no,yes,do,does,did,can,will,just,like,what,when,where,who,how,why,all,any,more,my,me,hi,hey,hello,thanks,thank,please,ok,okay".split(","),
);

export interface CommunitySignals {
  totals: { messages: number; members: number };
  velocity: Array<{ hour: string; count: number }>;
  topTerms: Array<{ term: string; count: number }>;
  recentTerms: Array<{ term: string; count: number }>;
  repeatClusters: Array<{ text: string; count: number; senders: number }>;
  supportByStatus: Array<{ status: string; count: number }>;
  moderationByCategory: Array<{ category: string; count: number }>;
  alertsBySeverity: Array<{ severity: string; count: number }>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9#@+_ ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 60);
}

function tally(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function top(map: Map<string, number>, n: number) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

export async function getCommunitySignals(
  communityId: string,
  windowDays = 7,
  messageLimit = 500,
): Promise<CommunitySignals> {
  const since = new Date(Date.now() - windowDays * 24 * 3600_000);
  const recentCutoff = new Date(Date.now() - 6 * 3600_000);

  const msgRows = await db
    .select({ text: messages.text, createdAt: messages.createdAt, memberId: messages.memberId })
    .from(messages)
    .where(and(eq(messages.communityId, communityId), gte(messages.createdAt, since)))
    .orderBy(desc(messages.createdAt))
    .limit(messageLimit);

  const hourBuckets = new Map<string, number>();
  const allTokens: string[] = [];
  const recentTokens: string[] = [];
  const textGroups = new Map<string, { count: number; senders: Set<string> }>();
  for (const m of msgRows) {
    const hour = m.createdAt.toISOString().slice(0, 13) + ":00";
    hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
    if (m.text) {
      const toks = tokenize(m.text);
      allTokens.push(...toks);
      if (m.createdAt >= recentCutoff) recentTokens.push(...toks);
      const key = m.text.trim().toLowerCase();
      if (key.length >= 4) {
        const g = textGroups.get(key) ?? { count: 0, senders: new Set<string>() };
        g.count++;
        if (m.memberId) g.senders.add(m.memberId);
        textGroups.set(key, g);
      }
    }
  }

  const memberRows = await db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.communityId, communityId));
  const supportRows = await db
    .select({ status: supportIssues.status })
    .from(supportIssues)
    .where(eq(supportIssues.communityId, communityId));
  const modRows = await db
    .select({ category: moderationEvents.category })
    .from(moderationEvents)
    .where(eq(moderationEvents.communityId, communityId));
  const alertRows = await db
    .select({ severity: alerts.severity })
    .from(alerts)
    .where(eq(alerts.communityId, communityId));

  const countBy = <T extends string>(rows: Array<Record<string, T>>, key: string) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = String(r[key]);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([status, count]) => ({ status, count }));
  };

  return {
    totals: { messages: msgRows.length, members: memberRows.length },
    velocity: [...hourBuckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-24)
      .map(([hour, count]) => ({ hour, count })),
    topTerms: top(tally(allTokens), 10),
    recentTerms: top(tally(recentTokens), 10),
    repeatClusters: [...textGroups.entries()]
      .filter(([, g]) => g.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([text, g]) => ({ text: text.slice(0, 120), count: g.count, senders: g.senders.size })),
    supportByStatus: countBy(supportRows, "status"),
    moderationByCategory: countBy(modRows, "category").map((r) => ({
      category: r.status,
      count: r.count,
    })),
    alertsBySeverity: countBy(alertRows, "severity").map((r) => ({
      severity: r.status,
      count: r.count,
    })),
  };
}

export async function summarizeCommunity(
  communityName: string,
  signals: CommunitySignals,
  client?: GeminiClient,
): Promise<string | null> {
  const gemini = client ?? (GeminiClient.isConfigured() ? GeminiClient.fromEnv() : null);
  if (!gemini) return null;
  const prompt = [
    `Summarize this Telegram community's recent operational state for a community manager in 5 short bullet points.`,
    `Stick to the numbers given; do not invent causes. Flag anything that looks like an emerging issue.`,
    ``,
    `Community: ${communityName}`,
    `Totals: ${JSON.stringify(signals.totals)}`,
    `Hourly velocity (last 24 buckets): ${JSON.stringify(signals.velocity)}`,
    `Top terms: ${JSON.stringify(signals.topTerms)}`,
    `Last-6h terms: ${JSON.stringify(signals.recentTerms)}`,
    `Repeat clusters: ${JSON.stringify(signals.repeatClusters)}`,
    `Support by status: ${JSON.stringify(signals.supportByStatus)}`,
    `Moderation by category: ${JSON.stringify(signals.moderationByCategory)}`,
    `Alerts by severity: ${JSON.stringify(signals.alertsBySeverity)}`,
  ].join("\n");
  try {
    return (await gemini.generateText(prompt, 512)).trim();
  } catch {
    return null;
  }
}
