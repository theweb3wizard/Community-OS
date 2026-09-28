import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getSession } from "@/lib/auth";

const NAV = [
  { href: "/dashboard", label: "Overview", exact: true },
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard/moderation", label: "Moderation" },
  { href: "/dashboard/support", label: "Support" },
  { href: "/dashboard/knowledge", label: "Knowledge" },
  { href: "/dashboard/intelligence", label: "Intelligence" },
  { href: "/dashboard/approvals", label: "Approvals" },
  { href: "/dashboard/activity", label: "Activity" },
  { href: "/dashboard/telegram", label: "Telegram" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-black">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-white p-4 md:flex dark:border-zinc-800 dark:bg-zinc-950">
        <Link href="/dashboard" className="px-2 py-3 text-base font-semibold">
          CommunityOS
        </Link>
        <nav className="mt-2 flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-zinc-200 px-2 pt-4 text-xs text-zinc-500 dark:border-zinc-800">
          <p className="truncate" title={session.email}>
            {session.email}
          </p>
          <form action="/api/auth/logout" method="post" className="mt-2">
            <button
              type="submit"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-zinc-200 bg-white px-6 py-3 md:hidden dark:border-zinc-800 dark:bg-zinc-950">
          <nav className="flex gap-3 overflow-x-auto text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="shrink-0">
                {item.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
