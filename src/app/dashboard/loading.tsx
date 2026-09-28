export default function DashboardLoading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6">
        <div className="h-7 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-zinc-200 dark:border-zinc-800" />
        ))}
      </div>
    </main>
  );
}
