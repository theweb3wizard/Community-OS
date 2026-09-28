import Link from "next/link";

import { CommunityPicker } from "@/components/dashboard/community-picker";
import {
  Card,
  EmptyState,
  SectionHeader,
} from "@/components/ui/primitives";
import { resolveCommunity } from "@/lib/dashboard/community";
import {
  getDashboardStats,
  recentActivity,
} from "@/lib/dashboard/queries";

function StatCard({
  title,
  value,
  hint,
  href,
}: {
  title: string;
  value: number;
  hint: string;
  href: string;
}) {
  return (
    <Link href={href}>
      <Card title={title} hint={hint}>
        <p className="text-3xl font-semibold">{value}</p>
      </Card>
    </Link>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string }>;
}) {
  const params = await searchParams;
  const { options, selectedId } = await resolveCommunity(params.community);
  if (!selectedId) {
    return (
      <div>
        <SectionHeader
          title="Overview"
          description="What is happening across your communities."
        />
        <EmptyState
          title="No community yet"
          body="Create your first community to start operating. The onboarding wizard walks through every step."
          action={
            <Link
              href="/onboarding"
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              Start onboarding
            </Link>
          }
        />
      </div>
    );
  }
  const [stats, activity] = await Promise.all([
    getDashboardStats(selectedId),
    recentActivity(selectedId, 8),
  ]);
  const isEmpty =
    stats.messages === 0 &&
    stats.moderationActions === 0 &&
    stats.supportOpen === 0 &&
    stats.approvalsPending === 0 &&
    stats.alertsOpen === 0;

  return (
    <div>
      <SectionHeader
        title="Overview"
        description="Live operational state — every number below is counted from the database."
      />
      <CommunityPicker options={options} selectedId={selectedId} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Messages observed" value={stats.messages} hint={`${stats.members} members tracked`} href={`/dashboard/activity?community=${selectedId}`} />
        <StatCard title="Moderation actions" value={stats.moderationActions} hint="delete / restrict / warn" href={`/dashboard/moderation?community=${selectedId}`} />
        <StatCard title="Pending approvals" value={stats.approvalsPending} hint="awaiting human decision" href="/dashboard/approvals" />
        <StatCard title="Open support" value={stats.supportOpen} hint={`${stats.supportResolved} resolved`} href={`/dashboard/support?community=${selectedId}`} />
        <StatCard title="Open alerts" value={stats.alertsOpen} hint="unresolved signals" href={`/dashboard/activity?community=${selectedId}`} />
      </div>
      {isEmpty ? (
        <div className="mt-6">
          <EmptyState
            title="Nothing to report yet"
            body="CommunityOS shows real operational data only. Connect Telegram and send messages to see this page come alive."
            action={
              <Link
                href="/dashboard/telegram"
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
              >
                Connect Telegram
              </Link>
            }
          />
        </div>
      ) : null}
      <div className="mt-6">
        <Card title="Recent activity" hint="Latest logged events across the system.">
          {activity.length === 0 ? (
            <p className="text-sm text-zinc-500">No activity logged yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {activity.map((a) => (
                <li key={a.id} className="flex flex-wrap gap-x-2 text-zinc-600 dark:text-zinc-400">
                  <span className="font-mono text-xs text-zinc-400">
                    {a.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                  <span className="font-mono text-xs rounded bg-zinc-100 px-1 dark:bg-zinc-900">{a.event}</span>
                  <span className="text-xs text-zinc-400">{a.actorType}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
