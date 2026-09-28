import { eq } from "drizzle-orm";

import { db } from "@/db";
import { activityLogs, alerts, communitySettings, supportIssues } from "@/db/schema";
import { GeminiClient } from "./gemini";
import { retrieveKnowledge, type RetrievedChunk } from "./knowledge";

// Support flow: question → retrieval → grounded generation → confidence gate.
// HIGH: answer from trusted knowledge. MEDIUM: cautious answer + support
// ticket. LOW: no generation at all — safe uncertainty + ticket + alert.
// The model may only speak from retrieved context; insufficiency escalates.

export type SupportConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface SupportAnswer {
  question: string;
  answer: string;
  confidence: SupportConfidence;
  sources: Array<{ title: string; kind: string; similarity: number }>;
  supportIssueId: string | null;
  alertId: string | null;
}

// v0 heuristics, calibrated against live Gemini embedding similarities
// (an exactly-answerable query scored ~0.66; unrelated text scores far lower).
const HIGH_THRESHOLD = 0.6;
const MEDIUM_THRESHOLD = 0.4;

const SAFE_UNKNOWN =
  "I don't have trusted information on this yet — I've flagged it for the community team, who will follow up.";

function sourcesOf(chunks: RetrievedChunk[]) {
  return chunks.map((c) => ({
    title: c.sourceTitle,
    kind: c.sourceKind,
    similarity: c.similarity,
  }));
}

async function logSupport(
  communityId: string,
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(activityLogs).values({
    communityId,
    actorType: "agent",
    event,
    detail,
  });
}

export async function answerSupport(
  communityId: string,
  question: string,
  opts: { memberId?: string; client?: GeminiClient } = {},
): Promise<SupportAnswer> {
  const q = question.trim().slice(0, 1000);
  if (!q) throw new Error("empty_question");
  const client = opts.client ?? GeminiClient.fromEnv();
  const settingsRows = await db
    .select()
    .from(communitySettings)
    .where(eq(communitySettings.communityId, communityId))
    .limit(1);
  const settings = settingsRows[0];
  const chunks = await retrieveKnowledge(
    communityId,
    q,
    settings?.retrievalLimit ?? 4,
    settings?.retrievalThreshold ?? 0.35,
    client,
  );
  const best = chunks[0]?.similarity ?? 0;

  if (best < MEDIUM_THRESHOLD || chunks.length === 0) {
    // LOW: do not generate. Escalate deterministically.
    const [issue] = await db
      .insert(supportIssues)
      .values({ communityId, title: q.slice(0, 200), body: q, status: "open", priority: "normal" })
      .returning({ id: supportIssues.id });
    const [alert] = await db
      .insert(alerts)
      .values({ communityId, severity: "normal", title: "Unanswered support question", body: q })
      .returning({ id: alerts.id });
    await logSupport(communityId, "support.escalated_low_confidence", {
      question: q,
      bestSimilarity: best,
      supportIssueId: issue.id,
    });
    return {
      question: q,
      answer: SAFE_UNKNOWN,
      confidence: "LOW",
      sources: [],
      supportIssueId: issue.id,
      alertId: alert.id,
    };
  }

  const context = chunks
    .map((c, i) => `[source ${i + 1}: ${c.sourceTitle}]\n${c.content}`)
    .join("\n\n");
  const cautious = best < HIGH_THRESHOLD;
  const prompt = [
    `You answer community support questions using ONLY the trusted sources below.`,
    cautious
      ? `Coverage is partial: be explicit about what is and isn't covered, hedge uncertain parts, and suggest asking a community admin for confirmation.`
      : `Answer directly from the sources and name the source you used.`,
    `If the sources do not contain the answer, reply with exactly: INSUFFICIENT_COVERAGE. Do not invent details, links, addresses, or procedures.`,
    ``,
    `Question: ${q}`,
    ``,
    `Sources:`,
    context,
  ].join("\n");

  const generated = (await client.generateText(prompt, 512)).trim();
  if (/INSUFFICIENT_COVERAGE/i.test(generated)) {
    const [issue] = await db
      .insert(supportIssues)
      .values({ communityId, title: q.slice(0, 200), body: q, status: "open", priority: "normal" })
      .returning({ id: supportIssues.id });
    await logSupport(communityId, "support.escalated_insufficient", {
      question: q,
      supportIssueId: issue.id,
    });
    return {
      question: q,
      answer: SAFE_UNKNOWN,
      confidence: "LOW",
      sources: sourcesOf(chunks),
      supportIssueId: issue.id,
      alertId: null,
    };
  }

  if (cautious) {
    const [issue] = await db
      .insert(supportIssues)
      .values({ communityId, title: q.slice(0, 200), body: q, status: "open", priority: "normal" })
      .returning({ id: supportIssues.id });
    await logSupport(communityId, "support.answered_medium", {
      question: q,
      bestSimilarity: best,
      supportIssueId: issue.id,
    });
    return {
      question: q,
      answer: generated,
      confidence: "MEDIUM",
      sources: sourcesOf(chunks),
      supportIssueId: issue.id,
      alertId: null,
    };
  }

  await logSupport(communityId, "support.answered_high", {
    question: q,
    bestSimilarity: best,
  });
  return {
    question: q,
    answer: generated,
    confidence: "HIGH",
    sources: sourcesOf(chunks),
    supportIssueId: null,
    alertId: null,
  };
}
