import type { CommunityOption } from "@/lib/dashboard/community";

export function CommunityPicker({
  options,
  selectedId,
}: {
  options: CommunityOption[];
  selectedId: string | null;
}) {
  if (options.length <= 1) return null;
  return (
    <form method="get" className="mb-4 flex gap-2">
      <select
        name="community"
        defaultValue={selectedId ?? undefined}
        aria-label="Community"
        className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      >
        {options.map((c) => (
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
  );
}
