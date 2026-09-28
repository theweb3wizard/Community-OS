import Link from "next/link";

import { CommunityPicker } from "@/components/dashboard/community-picker";
import { EmptyState, SectionHeader } from "@/components/ui/primitives";
import { resolveCommunity } from "@/lib/dashboard/community";
import { getInboxItems, type InboxItem } from "@/lib/dashboard/queries";

const BUCKETS = ["all", "urgent", "needs_review", "support", "community_issue", "resolved"] as const;

function bucketLabel(b: string): string {
  return b.replace(/_/g, " ");
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; bucket?: string }>;
}) {
  const params = await searchParams;
  const { options, selectedId } = await resolveCommunity(params.community);
  const bucket = BUCKETS.includes(params.bucket as (typeof BUCKETS)[number])
    ? params.bucket!
    : "all";
  const items: InboxItem[] = selectedId ? await getInboxItems(selectedId) : [];
  const shown = bucket === "all" ? items : items.filter((i) => i.bucket === bucket);

  return (
    <div>
      <SectionHeader
        title="Inbox"
        description="Everything needing operator attention, drawn from alerts, approvals, support, and agent actions."
      />
      <CommunityPicker options={options} selectedId={selectedId} />
      {!selectedId ? (
        <EmptyState title="No community" body="Create a community first." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2 text-xs">
            {BUCKETS.map((b) => (
              <Link
                key={b}
                href={`/dashboard/inbox?community=${selectedId}&bucket=${b}`}
                className={`rounded-full border px-3 py-1 ${bucket === b ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-300 dark:border-zinc-700"}`}
              >
                {bucketLabel(b)} ({b === "all" ? items.length : items.filter((i) => i.bucket === b).length})
              </Link>
            ))}
          </div>
          {shown.length === 0 ? (
            <EmptyState
              title="Inbox is empty"
              body={items.length === 0 ? "No alerts, approvals, support issues, or flagged actions. Items appear here as the community operates." : "Nothing in this bucket."}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="block rounded-xl border border-zinc-200 bg-white p-4 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  >
                    <p className="text-sm font-semibold">{item.title}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {bucketLabel(item.bucket)} · {item.subtitle}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
