import { and, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { activityLogs } from "@/db/schema";
import { CommunityPicker } from "@/components/dashboard/community-picker";
import { Card, EmptyState, SectionHeader } from "@/components/ui/primitives";
import { requireOperator } from "@/lib/authz";
import { getCommunitySignals, summarizeCommunity } from "@/lib/ai/intelligence";
import { resolveCommunity } from "@/lib/dashboard/community";

async function regenerateSummary(formData: FormData) {
  "use server";
  await requireOperator();
  const communityId = String(formData.get("communityId") ?? "");
  const communityName = String(formData.get("communityName") ?? "community");
  if (!communityId) redirect("/dashboard/intelligence?s=invalid");
  const signals = await getCommunitySignals(communityId);
  const summary = await summarizeCommunity(communityName, signals);
  await db.insert(activityLogs).values({
    communityId,
    actorType: "agent",
    event: "intelligence.summary_generated",
    detail: { summary: summary ?? null, generated: summary !== null },
  });
  redirect(`/dashboard/intelligence?community=${communityId}&s=${summary ? "generated" : "unavailable"}`);
}

export default async function IntelligencePage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; s?: string }>;
}) {
  const params = await searchParams;
  const { options, selectedId } = await resolveCommunity(params.community);
  const selectedName = options.find((o) => o.id === selectedId)?.name ?? "community";
  const signals = selectedId ? await getCommunitySignals(selectedId) : null;
  const latestSummary = selectedId
    ? (
        await db
          .select()
          .from(activityLogs)
          .where(
            and(
              eq(activityLogs.communityId, selectedId),
              eq(activityLogs.event, "intelligence.summary_generated"),
            ),
          )
          .orderBy(desc(activityLogs.createdAt))
          .limit(1)
      )[0]
    : undefined;
  const banner =
    params.s === "generated"
      ? "Fresh AI summary generated below."
      : params.s === "unavailable"
        ? "AI summary unavailable (Gemini not configured or failed). Observed data below is unaffected."
        : params.s === "invalid"
          ? "Invalid request."
          : null;
  const hasData =
    signals &&
    (signals.totals.messages > 0 ||
      signals.supportByStatus.length > 0 ||
      signals.moderationByCategory.length > 0);

  return (
    <div>
      <SectionHeader
        title="Intelligence"
        description="Operational signals from real activity. Observed data and AI interpretation are labeled separately."
      />
      <CommunityPicker options={options} selectedId={selectedId} />
      {banner ? (
        <p className="mb-4 rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          {banner}
        </p>
      ) : null}
      {!selectedId || !hasData ? (
        <EmptyState
          title="No intelligence yet"
          body="Recurring questions, topics, and trend signals appear here once the community produces activity."
        />
      ) : (
        signals && (
          <div className="grid gap-4">
            <Card title="Observed data" hint="Deterministic aggregations over the last 7 days (max 500 messages). Not measurements — signals.">
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="font-semibold">Totals</p>
                  <p className="text-zinc-500">{signals.totals.messages} messages · {signals.totals.members} members</p>
                </div>
                <div>
                  <p className="font-semibold">Top terms</p>
                  <p className="text-zinc-500">
                    {signals.topTerms.length === 0 ? "—" : signals.topTerms.slice(0, 8).map((t) => `${t.term} (${t.count})`).join(", ")}
                  </p>
                </div>
                <div>
                  <p className="font-semibold">Last 6 hours</p>
                  <p className="text-zinc-500">
                    {signals.recentTerms.length === 0 ? "—" : signals.recentTerms.slice(0, 8).map((t) => `${t.term} (${t.count})`).join(", ")}
                  </p>
                </div>
                <div>
                  <p className="font-semibold">Repeat clusters</p>
                  {signals.repeatClusters.length === 0 ? (
                    <p className="text-zinc-500">—</p>
                  ) : (
                    <ul className="text-zinc-500">
                      {signals.repeatClusters.map((c, i) => (
                        <li key={i}>“{c.text.slice(0, 80)}” ×{c.count} ({c.senders} senders)</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="font-semibold">Support by status</p>
                  <p className="text-zinc-500">
                    {signals.supportByStatus.length === 0 ? "—" : signals.supportByStatus.map((s) => `${s.status}: ${s.count}`).join(", ")}
                  </p>
                </div>
                <div>
                  <p className="font-semibold">Moderation by category</p>
                  <p className="text-zinc-500">
                    {signals.moderationByCategory.length === 0 ? "—" : signals.moderationByCategory.map((s) => `${s.category}: ${s.count}`).join(", ")}
                  </p>
                </div>
              </div>
            </Card>
            <Card title="AI-generated interpretation" hint="Gemini summary of the observed data above. May be wrong — always check the numbers.">
              <form action={regenerateSummary}>
                <input type="hidden" name="communityId" value={selectedId} />
                <input type="hidden" name="communityName" value={selectedName} />
                <button
                  type="submit"
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Generate summary
                </button>
              </form>
              <p className="mt-2 text-xs text-zinc-400">
                Summaries are recorded in the activity timeline as intelligence.summary_generated.
              </p>
              {(() => {
                const d = (latestSummary?.detail ?? {}) as Record<string, unknown>;
                if (!latestSummary || typeof d.summary !== "string") {
                  return <p className="mt-3 text-sm text-zinc-500">No summary generated yet.</p>;
                }
                return (
                  <div className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                    <p className="text-xs text-zinc-400">
                      Generated {latestSummary.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{d.summary}</p>
                  </div>
                );
              })()}
            </Card>
          </div>
        )
      )}
    </div>
  );
}
