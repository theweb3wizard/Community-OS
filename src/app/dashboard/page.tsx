import Link from "next/link";

import {
  Card,
  EmptyState,
  SectionHeader,
} from "@/components/ui/primitives";

export default function OverviewPage() {
  return (
    <div>
      <SectionHeader
        title="Overview"
        description="What is happening across your communities. Connect Telegram to start receiving live operations data."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Communities" hint="No community created yet.">
          <p className="text-3xl font-semibold">—</p>
        </Card>
        <Card title="Pending approvals" hint="Nothing awaiting review.">
          <p className="text-3xl font-semibold">—</p>
        </Card>
        <Card title="Open alerts" hint="No alerts raised.">
          <p className="text-3xl font-semibold">—</p>
        </Card>
      </div>
      <div className="mt-6">
        <EmptyState
          title="Nothing to report yet"
          body="CommunityOS shows real operational data only. Once a Telegram community is connected (Prompt 2+), moderation events, support issues, and intelligence will appear here."
          action={
            <Link
              href="/dashboard/settings"
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Review setup status
            </Link>
          }
        />
      </div>
    </div>
  );
}
