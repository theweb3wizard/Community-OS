import { and, desc, eq, ilike } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { activityLogs, supportIssues } from "@/db/schema";
import { CommunityPicker } from "@/components/dashboard/community-picker";
import { Card, EmptyState, SectionHeader } from "@/components/ui/primitives";
import { requireOperator } from "@/lib/authz";
import { resolveCommunity } from "@/lib/dashboard/community";

async function setStatus(formData: FormData) {
  "use server";
  await requireOperator();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !["open", "resolved", "closed"].includes(status)) {
    redirect("/dashboard/support?s=invalid");
  }
  await db
    .update(supportIssues)
    .set({ status, updatedAt: new Date() })
    .where(eq(supportIssues.id, id));
  await db.insert(activityLogs).values({
    communityId: null,
    actorType: "operator",
    event: "support.status_changed",
    detail: { supportIssueId: id, status },
  });
  redirect("/dashboard/support?s=status_updated");
}

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; s?: string }>;
}) {
  const params = await searchParams;
  const { options, selectedId } = await resolveCommunity(params.community);
  const issues = selectedId
    ? await db
        .select()
        .from(supportIssues)
        .where(eq(supportIssues.communityId, selectedId))
        .orderBy(desc(supportIssues.createdAt))
        .limit(50)
    : [];
  const supportEvents = selectedId
    ? await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.communityId, selectedId),
            ilike(activityLogs.event, "support.%"),
          ),
        )
        .orderBy(desc(activityLogs.createdAt))
        .limit(20)
    : [];
  const banner = params.s === "status_updated" ? "Status updated." : params.s === "invalid" ? "Invalid request." : null;

  return (
    <div>
      <SectionHeader
        title="Support"
        description="Questions from the community, generated responses with confidence, and escalation state."
      />
      <CommunityPicker options={options} selectedId={selectedId} />
      {banner ? (
        <p className="mb-4 rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          {banner}
        </p>
      ) : null}
      {!selectedId || (issues.length === 0 && supportEvents.length === 0) ? (
        <EmptyState
          title="No support issues"
          body="Support questions, answers with knowledge sources and confidence, and escalations appear here."
        />
      ) : (
        <div className="grid gap-4">
          <Card title={`Issues (${issues.length})`} hint="Triage queue — low-confidence and uncovered questions land here automatically.">
            {issues.length === 0 ? (
              <p className="text-sm text-zinc-500">Queue is clear.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {issues.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
                  >
                    <p className="font-semibold">{s.title}</p>
                    {s.body && s.body !== s.title ? (
                      <p className="mt-1 text-xs text-zinc-500">{s.body.slice(0, 300)}</p>
                    ) : null}
                    <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                      <span className="font-mono rounded bg-zinc-100 px-1 dark:bg-zinc-900">{s.status}</span>
                      <span>priority {s.priority}</span>
                      <form action={setStatus} className="inline-flex gap-1">
                        <input type="hidden" name="id" value={s.id} />
                        {["open", "resolved", "closed"].map((st) =>
                          st === s.status ? null : (
                            <button key={st} type="submit" name="status" value={st} className="underline hover:no-underline">
                              {st}
                            </button>
                          ),
                        )}
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Answer & escalation log" hint="What the support flow produced, with confidence — newest first.">
            {supportEvents.length === 0 ? (
              <p className="text-sm text-zinc-500">No generated answers yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs">
                {supportEvents.slice(0, 20).map((a) => {
                  const d = (a.detail ?? {}) as Record<string, unknown>;
                  return (
                    <li key={a.id} className="text-zinc-600 dark:text-zinc-400">
                      <span className="font-mono text-zinc-400">{a.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>{" "}
                      <span className="font-mono rounded bg-zinc-100 px-1 dark:bg-zinc-900">{a.event}</span>{" "}
                      {typeof d.question === "string" ? `“${d.question.slice(0, 100)}”` : ""}
                      {typeof d.bestSimilarity === "number" ? ` · similarity ${d.bestSimilarity.toFixed(3)}` : ""}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
