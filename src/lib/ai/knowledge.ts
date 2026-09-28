import { cosineDistance, desc, gt, sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { knowledgeChunks, knowledgeSources } from "@/db/schema";
import { AiProviderError, GeminiClient } from "./gemini";

// Trusted knowledge: source → chunk → embed (1536d, pgvector) → retrieve.
// Retrieval feeds support answers and (later) agent context. Nothing outside
// this store is ever treated as authoritative.

export type KnowledgeKind = "text" | "faq" | "url" | "doc" | "announcement" | "policy";

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourceKind: string;
  content: string;
  similarity: number;
}

/** Paragraph-aware chunking with character overlap. Pure — unit-tested. */
export function chunkText(text: string, maxChars = 500, overlap = 50): string[] {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = t.slice(-overlap);
  };
  for (const para of paras) {
    if (para.length > maxChars) {
      // Hard-split oversized paragraphs on sentence boundaries first.
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if ((current + " " + s).trim().length > maxChars) push();
        current = `${current} ${s}`.trim();
      }
      continue;
    }
    if ((current + "\n\n" + para).trim().length > maxChars && current.trim()) push();
    current = `${current}\n\n${para}`.trim();
  }
  push();
  return chunks.filter((c) => c.length > 0);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchUrlText(url: string): Promise<{ title: string; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AiProviderError("knowledge", `invalid url: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AiProviderError("knowledge", `unsupported url scheme: ${parsed.protocol}`);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "CommunityOS-knowledge/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AiProviderError("knowledge", `fetch failed: ${error instanceof Error ? error.message : url}`);
  }
  if (!res.ok) throw new AiProviderError("knowledge", `fetch http ${res.status}`);
  const html = await res.text();
  const sliced = html.slice(0, 60_000);
  const title = sliced.match(/<title[^>]*>([\s\S]{1,300})<\/title>/i)?.[1]?.trim() ?? url;
  const text = stripHtml(sliced).slice(0, 20_000);
  if (text.length < 50) throw new AiProviderError("knowledge", "page yielded no usable text");
  return { title, text };
}

export async function createSource(input: {
  communityId: string;
  kind: KnowledgeKind;
  title: string;
  uri?: string;
  content?: string;
  client?: GeminiClient;
}): Promise<{ sourceId: string; chunks: number }> {
  let content = (input.content ?? "").trim();
  let title = input.title.trim();
  if (input.kind === "url") {
    if (!input.uri) throw new AiProviderError("knowledge", "url source requires uri");
    const fetched = await fetchUrlText(input.uri);
    content = fetched.text;
    if (!title) title = fetched.title;
  }
  if (!title) throw new AiProviderError("knowledge", "title is required");
  if (content.length < 20) throw new AiProviderError("knowledge", "content too short (<20 chars)");
  const client = input.client ?? GeminiClient.fromEnv();

  const [source] = await db
    .insert(knowledgeSources)
    .values({
      communityId: input.communityId,
      kind: input.kind,
      title: title.slice(0, 200),
      uri: input.uri ?? null,
      content: content.slice(0, 20_000),
    })
    .returning({ id: knowledgeSources.id });

  const chunks = chunkText(content);
  const vectors = await client.embed(chunks, "RETRIEVAL_DOCUMENT");
  await db.insert(knowledgeChunks).values(
    chunks.map((c, i) => ({
      communityId: input.communityId,
      sourceId: source.id,
      content: c,
      embedding: vectors[i],
      tokenCount: Math.ceil(c.length / 4),
    })),
  );
  return { sourceId: source.id, chunks: chunks.length };
}

export async function retrieveKnowledge(
  communityId: string,
  query: string,
  limit = 4,
  minSimilarity = 0.35,
  client?: GeminiClient,
): Promise<RetrievedChunk[]> {
  const gemini = client ?? GeminiClient.fromEnv();
  const [vector] = await gemini.embed([query.slice(0, 2000)], "RETRIEVAL_QUERY");
  const similarity = sql<number>`1 - (${cosineDistance(knowledgeChunks.embedding, vector)})`;
  const rows = await db
    .select({
      chunkId: knowledgeChunks.id,
      sourceId: knowledgeSources.id,
      sourceTitle: knowledgeSources.title,
      sourceKind: knowledgeSources.kind,
      content: knowledgeChunks.content,
      similarity,
    })
    .from(knowledgeChunks)
    .innerJoin(knowledgeSources, eq(knowledgeChunks.sourceId, knowledgeSources.id))
    .where(and(eq(knowledgeChunks.communityId, communityId), gt(similarity, minSimilarity)))
    .orderBy(desc(similarity))
    .limit(limit);
  return rows;
}

export async function sourceChunks(
  sourceId: string,
  limit = 20,
): Promise<Array<{ id: string; content: string; tokenCount: number | null }>> {
  const rows = await db
    .select({ id: knowledgeChunks.id, content: knowledgeChunks.content, tokenCount: knowledgeChunks.tokenCount })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.sourceId, sourceId))
    .limit(limit);
  return rows;
}

export async function deleteSource(sourceId: string): Promise<void> {
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
  await db.delete(knowledgeSources).where(eq(knowledgeSources.id, sourceId));
}

export async function sourceChunkCounts(
  communityId: string,
): Promise<Array<{ id: string; kind: string; title: string; uri: string | null; chunks: number }>> {
  const sources = await db
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.communityId, communityId));
  const counts = await db
    .select({ sourceId: knowledgeChunks.sourceId })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.communityId, communityId));
  const tally = new Map<string, number>();
  for (const c of counts) {
    if (c.sourceId) tally.set(c.sourceId, (tally.get(c.sourceId) ?? 0) + 1);
  }
  return sources.map((s) => ({
    id: s.id,
    kind: s.kind,
    title: s.title,
    uri: s.uri,
    chunks: tally.get(s.id) ?? 0,
  }));
}
