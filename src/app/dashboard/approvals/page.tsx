import { desc } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { approvals, communities } from "@/db/schema";
import { Card, EmptyState, SectionHeader } from "@/components/ui/primitives";
import { decideApproval } from "@/lib/approvals/service";
import { getSession } from "@/lib/auth";
import { TelegramClient } from "@/lib/telegram/client";

async function decide(formData: FormData) {
  "use server";
  const session = await getSession();
  if (!session) redirect("/login");
  const approvalId = String(formData.get("approvalId") ?? "");
  const choice = String(formData.get("choice") ?? "");
  if (!approvalId || (choice !== "approve" && choice !== "reject")) {
    redirect("/dashboard/approvals?s=invalid");
  }
  let client: TelegramClient | undefined;
  try {
    client = TelegramClient.fromEnv();
  } catch {
    client = undefined;
  }
  const result = await decideApproval({
    byId: approvalId,
    choice,
    actor: { kind: "dashboard", email: session.email },
    client,
  });
  redirect(`/dashboard/approvals?s=${result.outcome}`);
}

const STATUS_MESSAGES: Record<string, string> = {
  approved_executed: "Approved and executed.",
  approved_failed: "Approved, but execution failed — see the entry below.",
  rejected: "Rejected. No action was taken.",
  already_decided: "Already decided — nothing changed.",
  unauthorized: "Not authorized.",
  expired: "Approval had expired.",
  not_found: "Approval not found.",
  invalid: "Invalid request.",
};

function detailText(d: unknown): { evidence: string; confidence: unknown; tool: string } {
  const detail = (d ?? {}) as Record<string, unknown>;
  const evidence = [
    detail.classification ? `classification: ${String(detail.classification)}` : null,
    typeof detail.confidence === "number" ? `confidence: ${detail.confidence}` : null,
    detail.policyReason ? `policy: ${String(detail.policyReason)}` : null,
    detail.risk ? `risk: ${String(detail.risk)}` : null,
    detail.messageText ? `message: ${String(detail.messageText).slice(0, 200)}` : null,
    detail.senderUsername ? `user: @${String(detail.senderUsername)} (${String(detail.senderId ?? "?")})` : detail.senderId ? `user id: ${String(detail.senderId)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    evidence: evidence || "no evidence recorded",
    confidence: detail.confidence ?? "?",
    tool: String(detail.tool ?? "?"),
  };
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string }>;
}) {
  const params = await searchParams;
  const banner = params.s ? (STATUS_MESSAGES[params.s] ?? params.s) : null;

  const rows = await db
    .select()
    .from(approvals)
    .orderBy(desc(approvals.createdAt))
    .limit(50);
  const communityRows = await db.select().from(communities);
  const communityName = (id: string) =>
    communityRows.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  return (
    <div>
      <SectionHeader
        title="Approvals"
        description="Agent-proposed actions awaiting a human decision. Approving executes the action exactly once; rejecting takes no action."
      />
      {banner ? (
        <p className="mb-4 rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          {banner}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title="Nothing awaiting approval"
          body="Warnings, restrictions, and sensitive responses queue here once the agent proposes them."
        />
      ) : (
        <div className="grid gap-4">
          <Card title={`Pending (${pending.length})`} hint="Decide promptly — approvals expire 24 hours after creation.">
            {pending.length === 0 ? (
              <p className="text-sm text-zinc-500">Queue is clear.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {pending.map((a) => {
                  const info = detailText(a.detail);
                  return (
                    <li
                      key={a.id}
                      className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                    >
                      <p className="text-sm font-semibold">
                        {a.title} <span className="font-normal text-zinc-500">· {communityName(a.communityId)}</span>
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">{info.evidence}</p>
                      <div className="mt-2 flex gap-2">
                        <form action={decide} className="inline">
                          <input type="hidden" name="approvalId" value={a.id} />
                          <input type="hidden" name="choice" value="approve" />
                          <button
                            type="submit"
                            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                          >
                            Approve
                          </button>
                        </form>
                        <form action={decide} className="inline">
                          <input type="hidden" name="approvalId" value={a.id} />
                          <input type="hidden" name="choice" value="reject" />
                          <button
                            type="submit"
                            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                          >
                            Reject
                          </button>
                        </form>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          {decided.length > 0 ? (
            <Card title={`Decided (${decided.length})`} hint="Latest outcomes, newest first.">
              <ul className="flex flex-col gap-2">
                {decided.slice(0, 10).map((a) => {
                  const info = detailText(a.detail);
                  return (
                    <li key={a.id} className="text-xs text-zinc-500">
                      <span className="font-mono rounded bg-zinc-100 px-1 dark:bg-zinc-900">{a.status}</span>{" "}
                      {a.title} · {communityName(a.communityId)} · {info.evidence}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
