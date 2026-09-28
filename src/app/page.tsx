import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "CommunityOS — AI-native community operations",
  description:
    "Observe, understand, decide, authorize, act, log, escalate. Community operations for Web3 Telegram communities.",
};

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
        CommunityOS · Foundation (Prompt 1)
      </p>
      <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Community operations, with humans in control.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-zinc-600 dark:text-zinc-400">
        CommunityOS observes Telegram activity, interprets it with AI, and only
        acts within policy — consequential decisions stay with human operators.
        This build establishes the application foundation: auth, dashboard
        shell, database schema, and environment plumbing. The Telegram agent
        and AI providers land in later prompts.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href="/login"
          className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Sign in
        </Link>
        <Link
          href="/dashboard"
          className="rounded-lg border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Open dashboard
        </Link>
      </div>

      <div className="mt-12 grid gap-4 sm:grid-cols-3">
        {[
          {
            title: "Observe → Understand",
            body: "Telegram events are ingested and classified. Deterministic checks run before any AI call.",
          },
          {
            title: "Decide → Authorize",
            body: "A decision provider recommends; the policy engine allows auto, approval, or human-only paths.",
          },
          {
            title: "Act → Log → Escalate",
            body: "Approved actions execute via Telegram, everything is logged, uncertainty escalates.",
          },
        ].map((c) => (
          <div
            key={c.title}
            className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <h2 className="text-sm font-semibold">{c.title}</h2>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
              {c.body}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-12 text-xs text-zinc-400">
        No demo metrics on this page. Operational data appears only after a
        Telegram community is connected in a later prompt.
      </p>
    </main>
  );
}
