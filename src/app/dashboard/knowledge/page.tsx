import { redirect } from "next/navigation";

import { db } from "@/db";
import { communities } from "@/db/schema";
import { ConfirmButton } from "@/components/dashboard/confirm-button";
import { requireOperator } from "@/lib/authz";
import { Card, EmptyState, SectionHeader } from "@/components/ui/primitives";
import { GeminiClient } from "@/lib/ai/gemini";
import {
  createSource,
  deleteSource,
  sourceChunkCounts,
  sourceChunks,
  type KnowledgeKind,
} from "@/lib/ai/knowledge";

const KINDS: KnowledgeKind[] = ["text", "faq", "url", "doc", "announcement", "policy"];

async function addSource(formData: FormData) {
  "use server";
  await requireOperator();
  const communityId = String(formData.get("communityId") ?? "");
  const kind = String(formData.get("kind") ?? "") as KnowledgeKind;
  const title = String(formData.get("title") ?? "").trim();
  const uri = String(formData.get("uri") ?? "").trim();
  const content = String(formData.get("content") ?? "");
  if (!communityId || !KINDS.includes(kind)) redirect("/dashboard/knowledge?s=invalid");
  try {
    const { chunks } = await createSource({
      communityId,
      kind,
      title: title || uri || `${kind} source`,
      uri: uri || undefined,
      content: content || undefined,
      client: GeminiClient.fromEnv(),
    });
    redirect(`/dashboard/knowledge?s=ingested_${chunks}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "ingest_failed";
    if (msg.includes("GEMINI_API_KEY")) redirect("/dashboard/knowledge?s=no_gemini");
    redirect("/dashboard/knowledge?s=ingest_failed");
  }
}

async function removeSource(formData: FormData) {
  "use server";
  await requireOperator();
  const id = String(formData.get("id") ?? "");
  const communityId = String(formData.get("communityId") ?? "");
  if (!id) redirect("/dashboard/knowledge?s=invalid");
  await deleteSource(id);
  redirect(`/dashboard/knowledge?community=${communityId}&s=deleted`);
}

async function ChunkList({ sourceId }: { sourceId: string }) {
  const chunks = await sourceChunks(sourceId, 20);
  if (chunks.length === 0) return <p className="mt-1">No chunks stored.</p>;
  return (
    <ul className="mt-1 flex flex-col gap-1">
      {chunks.map((c, i) => (
        <li key={c.id} className="rounded bg-zinc-50 p-2 dark:bg-zinc-900">
          <span className="font-mono text-zinc-400">#{i + 1} · ~{c.tokenCount ?? "?"} tokens</span>
          <p className="mt-0.5 whitespace-pre-wrap">{c.content.slice(0, 400)}</p>
        </li>
      ))}
    </ul>
  );
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string; community?: string }>;
}) {
  const params = await searchParams;
  const communityRows = await db.select().from(communities);
  const selectedId =
    params.community && communityRows.some((c) => c.id === params.community)
      ? params.community
      : communityRows[0]?.id;
  const sources = selectedId ? await sourceChunkCounts(selectedId) : [];

  let banner: string | null = null;
  const s = params.s ?? "";
  if (s.startsWith("ingested_")) banner = `Source ingested and embedded (${s.slice(9)} chunks).`;
  else if (s === "no_gemini") banner = "GEMINI_API_KEY is not configured on the server.";
  else if (s === "ingest_failed") banner = "Ingestion failed (URL unreachable, content too short, or embedding error).";
  else if (s === "deleted") banner = "Source and its chunks deleted.";
  else if (s === "invalid") banner = "Invalid request.";

  return (
    <div>
      <SectionHeader
        title="Knowledge"
        description="Trusted sources only: answers are generated exclusively from this store. Anything uncovered escalates instead of being invented."
      />
      {banner ? (
        <p className="mb-4 rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          {banner}
        </p>
      ) : null}
      {communityRows.length === 0 ? (
        <EmptyState
          title="No communities yet"
          body="Create a community on the Telegram page first, then add trusted knowledge here."
        />
      ) : (
        <div className="grid gap-4">
          <Card title="Community" hint="Knowledge is scoped per community.">
            <form method="get" className="flex gap-2">
              <select
                name="community"
                defaultValue={selectedId}
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                {communityRows.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Switch
              </button>
            </form>
          </Card>

          <Card
            title="Sources"
            hint="Each source is chunked, embedded (1536d), and stored in pgvector for retrieval."
          >
            {sources.length === 0 ? (
              <p className="text-sm text-zinc-500">No sources yet — add the first below.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {sources.map((src) => (
                  <li
                    key={src.id}
                    className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{src.title}</span>{" "}
                      <span className="text-xs text-zinc-500">
                        [{src.kind}] · {src.chunks} chunks
                        {src.uri ? ` · ${src.uri.slice(0, 60)}` : ""}
                      </span>
                      <span className="ml-auto">
                        <ConfirmButton
                          action={removeSource}
                          label="Delete"
                          confirmLabel="Confirm delete"
                          warning="Deletes source and all chunks."
                          hidden={{ id: src.id, communityId: selectedId ?? "" }}
                          className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 dark:border-red-900"
                        />
                      </span>
                    </div>
                    <details className="mt-2 text-xs text-zinc-500">
                      <summary className="cursor-pointer underline">View chunks (retrieval units)</summary>
                      <ChunkList sourceId={src.id} />
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Add source" hint="URL sources are fetched server-side with basic text extraction.">
            <form action={addSource} className="flex flex-col gap-3">
              <input type="hidden" name="communityId" value={selectedId ?? ""} />
              <div className="flex gap-2">
                <select
                  name="kind"
                  defaultValue="faq"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <input
                  name="title"
                  maxLength={200}
                  placeholder="Title (optional for URLs)"
                  className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
              </div>
              <input
                name="uri"
                placeholder="https://… (required for kind=url)"
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <textarea
                name="content"
                rows={5}
                placeholder="Paste trusted content here (text/faq/doc/announcement/policy)…"
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                type="submit"
                className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Ingest
              </button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
