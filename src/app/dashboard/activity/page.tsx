import { CommunityPicker } from "@/components/dashboard/community-picker";
import { EmptyState, SectionHeader } from "@/components/ui/primitives";
import { resolveCommunity } from "@/lib/dashboard/community";
import { getActivityRows } from "@/lib/dashboard/queries";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; q?: string; actor?: string; event?: string }>;
}) {
  const params = await searchParams;
  const { options, selectedId } = await resolveCommunity(params.community);
  const filter = {
    q: params.q || undefined,
    actor: params.actor || undefined,
    event: params.event || undefined,
  };
  const rows = selectedId ? await getActivityRows(selectedId, { ...filter, limit: 100 }) : [];

  return (
    <div>
      <SectionHeader
        title="Activity"
        description="Searchable, filterable timeline of everything the system and operators did."
      />
      <CommunityPicker options={options} selectedId={selectedId} />
      {!selectedId ? (
        <EmptyState title="No community" body="Create a community first." />
      ) : (
        <>
          <form method="get" className="mb-4 flex flex-wrap gap-2">
            <input type="hidden" name="community" value={selectedId} />
            <input
              name="q"
              defaultValue={filter.q ?? ""}
              placeholder="Search events…"
              aria-label="Search events"
              className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <select
              name="actor"
              defaultValue={filter.actor ?? ""}
              aria-label="Actor"
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">all actors</option>
              <option value="agent">agent</option>
              <option value="system">system</option>
              <option value="operator">operator</option>
            </select>
            <input
              name="event"
              defaultValue={filter.event ?? ""}
              placeholder="event contains…"
              aria-label="Event contains"
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="submit"
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              Filter
            </button>
          </form>
          {rows.length === 0 ? (
            <EmptyState
              title="No activity logged"
              body="Matching events will appear here with actor, event name, and timestamp."
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {rows.map((a) => (
                <li
                  key={a.id}
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <span className="font-mono text-zinc-400">
                    {a.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>{" "}
                  <span className="font-mono rounded bg-zinc-100 px-1 dark:bg-zinc-900">{a.event}</span>{" "}
                  <span className="text-zinc-500">{a.actorType}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
