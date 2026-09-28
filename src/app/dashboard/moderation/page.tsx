import Link from "next/link";

import { CommunityPicker } from "@/components/dashboard/community-picker";
import { EmptyState, SectionHeader } from "@/components/ui/primitives";
import { resolveCommunity } from "@/lib/dashboard/community";
import { getModerationRows } from "@/lib/dashboard/queries";

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string }>;
}) {
  const params = await searchParams;
  const { options, selectedId } = await resolveCommunity(params.community);
  const rows = selectedId ? await getModerationRows(selectedId) : [];

  return (
    <div>
      <SectionHeader
        title="Moderation"
        description="Every delete, restriction, and warning the agent took or proposed — with evidence and outcomes."
      />
      <CommunityPicker options={options} selectedId={selectedId} />
      {!selectedId || rows.length === 0 ? (
        <EmptyState
          title="No moderation events"
          body="Moderation actions appear here with their classification, evidence, and result once the agent acts."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">{r.kind.replace(/_/g, " ")}</span>
                <span className="font-mono text-xs rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-900">
                  {r.status}
                </span>
                {r.classification ? (
                  <span className="text-xs text-zinc-500">· {r.classification}</span>
                ) : null}
                <span className="ml-auto text-xs text-zinc-400">
                  {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              </div>
              {r.messageText ? (
                <p className="mt-2 truncate text-sm text-zinc-600 dark:text-zinc-400">
                  “{r.messageText.slice(0, 160)}”
                </p>
              ) : null}
              <p className="mt-1 text-xs text-zinc-500">
                {r.senderUsername ? `@${r.senderUsername} ` : ""}
                {r.senderTelegramId ? `(${r.senderTelegramId})` : "unknown sender"}
                {r.reason ? ` · ${r.reason.slice(0, 160)}` : ""}
              </p>
              <div className="mt-2 flex gap-3 text-xs">
                {r.messageDbId ? (
                  <Link href={`/dashboard/messages/${r.messageDbId}`} className="underline">
                    Trace message
                  </Link>
                ) : null}
                {r.approvalId ? (
                  <Link href="/dashboard/approvals" className="underline">
                    View approval
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
