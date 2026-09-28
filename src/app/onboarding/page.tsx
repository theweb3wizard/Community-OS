import Link from "next/link";
import { count, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db";
import {
  communities,
  knowledgeSources,
  policies,
  telegramConnections,
} from "@/db/schema";
import { Card, SectionHeader } from "@/components/ui/primitives";
import { getSession } from "@/lib/auth";

interface Step {
  key: string;
  title: string;
  body: string;
  done: boolean;
  href: string;
  action: string;
}

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // Signed-in account is step 1 (dashboard layout already requires session).
  const communityRows = await db
    .select({ id: communities.id, name: communities.name })
    .from(communities);
  const communityId = communityRows[0]?.id ?? null;

  const [connections, policiesCount, knowledgeCount] = communityId
    ? await Promise.all([
        db.select().from(telegramConnections).where(eq(telegramConnections.communityId, communityId)),
        db.select({ n: count() }).from(policies).where(eq(policies.communityId, communityId)),
        db.select({ n: count() }).from(knowledgeSources).where(eq(knowledgeSources.communityId, communityId)),
      ])
    : [[], [{ n: 0 }], [{ n: 0 }]];
  const chatLinked = connections.some((c) => c.telegramChatId);
  const adminLinked = connections.some((c) => c.adminTelegramUserId);
  const automationOn = policiesCount[0].n > 0;

  const steps: Step[] = [
    {
      key: "account",
      title: "Create account & sign in",
      body: "You are signed in. Team invitations and roles can be managed here as the workspace grows.",
      done: true,
      href: "/dashboard",
      action: "Done",
    },
    {
      key: "community",
      title: "Create community",
      body: communityRows.length > 0 ? `Created: ${communityRows.map((c) => c.name).join(", ")}` : "Give your community a name.",
      done: communityRows.length > 0,
      href: "/dashboard/telegram",
      action: "Create community",
    },
    {
      key: "telegram",
      title: "Connect Telegram",
      body: chatLinked
        ? `Linked: ${connections.find((c) => c.telegramChatId)?.chatTitle ?? "chat"}`
        : "Add the bot to your group and redeem a /connect code.",
      done: chatLinked,
      href: "/dashboard/telegram",
      action: "Connect Telegram",
    },
    {
      key: "admin",
      title: "Connect administrator",
      body: adminLinked ? "Administrator DM linked." : "DM the bot /admin CODE so approvals reach you.",
      done: adminLinked,
      href: "/dashboard/telegram",
      action: "Connect administrator",
    },
    {
      key: "policies",
      title: "Configure basic policies",
      body: automationOn
        ? `${policiesCount[0].n} polic${policiesCount[0].n === 1 ? "y" : "ies"} active.`
        : "Standard mode auto-handles corroborated spam; strict mode approves everything.",
      done: automationOn,
      href: "/dashboard/settings",
      action: "Configure policies",
    },
    {
      key: "knowledge",
      title: "Add knowledge",
      body: knowledgeCount[0].n > 0 ? `${knowledgeCount[0].n} trusted sources.` : "FAQs and docs the agent may answer from.",
      done: knowledgeCount[0].n > 0,
      href: "/dashboard/knowledge",
      action: "Add knowledge",
    },
    {
      key: "automation",
      title: "Enable automation",
      body: automationOn
        ? "An active policy authorizes the agent loop."
        : "Automation turns on with your first active policy.",
      done: automationOn,
      href: "/dashboard/settings",
      action: "Enable automation",
    },
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <SectionHeader
        title="Onboarding"
        description={`${done} of ${steps.length} steps complete. Nothing here is mandatory — skip ahead any time.`}
      />
      <div className="mb-6 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full bg-zinc-900 dark:bg-zinc-100"
          style={{ width: `${Math.round((done / steps.length) * 100)}%` }}
        />
      </div>
      <div className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <Card key={s.key} title={`${i + 1}. ${s.title}`} hint={s.body}>
            {s.done ? (
              <p className="text-sm text-green-600">✓ Complete</p>
            ) : (
              <Link
                href={s.href}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                {s.action}
              </Link>
            )}
          </Card>
        ))}
      </div>
      <div className="mt-6">
        <Link href="/dashboard" className="text-sm underline">
          Go to dashboard →
        </Link>
      </div>
    </div>
  );
}
