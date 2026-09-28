import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db";
import {
  communities,
  communitySettings,
  policies,
  telegramConnections,
} from "@/db/schema";
import { CommunityPicker } from "@/components/dashboard/community-picker";
import { ConfirmButton } from "@/components/dashboard/confirm-button";
import { Card, SectionHeader } from "@/components/ui/primitives";
import { resolveCommunity } from "@/lib/dashboard/community";

const POLICY_TOOLS = ["delete_message", "restrict_user", "warn_user", "send_reply"] as const;

async function renameCommunity(formData: FormData) {
  "use server";
  const communityId = String(formData.get("communityId") ?? "");
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!communityId || !name) redirect("/dashboard/settings?s=invalid");
  await db.update(communities).set({ name, updatedAt: new Date() }).where(eq(communities.id, communityId));
  redirect(`/dashboard/settings?community=${communityId}&s=renamed`);
}

async function createPolicy(formData: FormData) {
  "use server";
  const communityId = String(formData.get("communityId") ?? "");
  const name = String(formData.get("name") ?? "").trim().slice(0, 80) || "Default policy";
  const mode = String(formData.get("mode") ?? "standard");
  const autoDeleteSpam = formData.get("autoDeleteSpam") === "on";
  const flood = Math.max(2, Math.min(100, Number(formData.get("floodThreshold") ?? 10) || 10));
  const repeat = Math.max(2, Math.min(20, Number(formData.get("repeatThreshold") ?? 3) || 3));
  const split = (v: FormDataEntryValue | null) =>
    String(v ?? "")
      .split(/[\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 50);
  const requireApproval = POLICY_TOOLS.filter((t) => formData.get(`appr_${t}`) === "on");
  if (!communityId || (mode !== "standard" && mode !== "strict")) {
    redirect("/dashboard/settings?s=invalid");
  }
  await db.insert(policies).values({
    communityId,
    name,
    rules: {
      mode,
      autoDeleteSpam,
      floodThreshold: flood,
      repeatThreshold: repeat,
      blockedDomains: split(formData.get("blockedDomains")),
      allowlistedDomains: split(formData.get("allowlistedDomains")),
      requireApproval,
    },
    isActive: true,
  });
  redirect(`/dashboard/settings?community=${communityId}&s=policy_created`);
}

async function togglePolicy(formData: FormData) {
  "use server";
  const id = String(formData.get("id") ?? "");
  const communityId = String(formData.get("communityId") ?? "");
  const rows = await db.select().from(policies).where(eq(policies.id, id)).limit(1);
  if (!rows[0]) redirect("/dashboard/settings?s=invalid");
  await db
    .update(policies)
    .set({ isActive: !rows[0].isActive, updatedAt: new Date() })
    .where(eq(policies.id, id));
  redirect(`/dashboard/settings?community=${communityId}&s=policy_updated`);
}

async function deletePolicy(formData: FormData) {
  "use server";
  const id = String(formData.get("id") ?? "");
  const communityId = String(formData.get("communityId") ?? "");
  await db.delete(policies).where(and(eq(policies.id, id), eq(policies.communityId, communityId)));
  redirect(`/dashboard/settings?community=${communityId}&s=policy_deleted`);
}

async function unlinkAdmin(formData: FormData) {
  "use server";
  const id = String(formData.get("id") ?? "");
  const communityId = String(formData.get("communityId") ?? "");
  await db
    .update(telegramConnections)
    .set({ adminTelegramUserId: null, updatedAt: new Date() })
    .where(eq(telegramConnections.id, id));
  redirect(`/dashboard/settings?community=${communityId}&s=admin_unlinked`);
}

async function saveCommunitySettings(formData: FormData) {
  "use server";
  const communityId = String(formData.get("communityId") ?? "");
  if (!communityId) redirect("/dashboard/settings?s=invalid");
  const threshold = Math.min(0.95, Math.max(0, Number(formData.get("retrievalThreshold") ?? 0.35) || 0.35));
  const limit = Math.max(1, Math.min(10, Number(formData.get("retrievalLimit") ?? 4) || 4));
  const values = {
    communityId,
    retrievalThreshold: threshold,
    retrievalLimit: limit,
    notifyApprovals: formData.get("notifyApprovals") === "on",
    notifyFailures: formData.get("notifyFailures") === "on",
    updatedAt: new Date(),
  };
  const existing = await db
    .select({ id: communitySettings.id })
    .from(communitySettings)
    .where(eq(communitySettings.communityId, communityId))
    .limit(1);
  if (existing[0]) {
    await db.update(communitySettings).set(values).where(eq(communitySettings.id, existing[0].id));
  } else {
    await db.insert(communitySettings).values(values);
  }
  redirect(`/dashboard/settings?community=${communityId}&s=settings_saved`);
}

const STATUS: Record<string, string> = {
  renamed: "Community renamed.",
  policy_created: "Policy created and active.",
  policy_updated: "Policy updated.",
  policy_deleted: "Policy deleted.",
  admin_unlinked: "Administrator Telegram unlinked. Re-link with a fresh admin code.",
  settings_saved: "Settings saved.",
  invalid: "Invalid request.",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; s?: string }>;
}) {
  const params = await searchParams;
  const { options, selectedId } = await resolveCommunity(params.community);
  const banner = params.s ? (STATUS[params.s] ?? null) : null;

  const policyRows = selectedId
    ? await db.select().from(policies).where(eq(policies.communityId, selectedId))
    : [];
  const connectionRows = selectedId
    ? await db
        .select()
        .from(telegramConnections)
        .where(eq(telegramConnections.communityId, selectedId))
    : [];
  const settingsRows = selectedId
    ? await db
        .select()
        .from(communitySettings)
        .where(eq(communitySettings.communityId, selectedId))
        .limit(1)
    : [];
  const settings = settingsRows[0];
  const selectedName = options.find((o) => o.id === selectedId)?.name ?? "";

  return (
    <div>
      <SectionHeader
        title="Settings"
        description="Community, policies, automation thresholds, knowledge retrieval, and notifications."
      />
      <CommunityPicker options={options} selectedId={selectedId} />
      {banner ? (
        <p className="mb-4 rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          {banner}
        </p>
      ) : null}
      {!selectedId ? (
        <p className="text-sm text-zinc-500">Create a community on the Telegram page first.</p>
      ) : (
        <div className="grid gap-4">
          <Card title="Community" hint="Rename or review the active community.">
            <form action={renameCommunity} className="flex gap-2">
              <input type="hidden" name="communityId" value={selectedId} />
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={selectedName}
                aria-label="Community name"
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                type="submit"
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Rename
              </button>
            </form>
          </Card>

          <Card
            title="Moderation policies"
            hint="Standard: corroborated spam auto-deletes, everything consequential needs approval. Strict: every mutation needs approval."
          >
            {policyRows.length === 0 ? (
              <p className="mb-3 text-sm text-zinc-500">
                No policies yet — the engine runs conservative defaults. Create one to tune behavior.
              </p>
            ) : (
              <ul className="mb-3 flex flex-col gap-2">
                {policyRows.map((p) => {
                  const r = (p.rules ?? {}) as Record<string, unknown>;
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800"
                    >
                      <span className="font-semibold">{p.name}</span>
                      <span className="font-mono rounded bg-zinc-100 px-1 dark:bg-zinc-900">
                        {String(r.mode ?? "standard")}
                      </span>
                      <span className={p.isActive ? "text-green-600" : "text-zinc-400"}>
                        {p.isActive ? "active" : "paused"}
                      </span>
                      <span className="ml-auto inline-flex gap-2">
                        <form action={togglePolicy} className="inline">
                          <input type="hidden" name="id" value={p.id} />
                          <input type="hidden" name="communityId" value={selectedId} />
                          <button type="submit" className="underline">
                            {p.isActive ? "Pause" : "Activate"}
                          </button>
                        </form>
                        <ConfirmButton
                          action={deletePolicy}
                          label="Delete"
                          confirmLabel="Confirm delete"
                          warning="Deletes this policy permanently."
                          hidden={{ id: p.id, communityId: selectedId }}
                          className="rounded border border-red-300 px-2 py-0.5 text-red-600 dark:border-red-900"
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <form action={createPolicy} className="flex flex-col gap-2 rounded-lg border border-dashed border-zinc-300 p-3 text-sm dark:border-zinc-700">
              <input type="hidden" name="communityId" value={selectedId} />
              <div className="flex gap-2">
                <input name="name" maxLength={80} placeholder="Policy name" aria-label="Policy name" className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950" />
                <select name="mode" defaultValue="standard" aria-label="Mode" className="rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950">
                  <option value="standard">standard</option>
                  <option value="strict">strict</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" name="autoDeleteSpam" defaultChecked />
                Auto-delete corroborated spam
              </label>
              <div className="flex gap-2 text-xs">
                <label className="flex flex-1 items-center gap-1">
                  Flood ≥ <input name="floodThreshold" type="number" defaultValue={10} min={2} max={100} className="w-16 rounded border border-zinc-300 px-1 py-1 dark:border-zinc-700 dark:bg-zinc-950" /> msgs
                </label>
                <label className="flex flex-1 items-center gap-1">
                  Repeat ≥ <input name="repeatThreshold" type="number" defaultValue={3} min={2} max={20} className="w-16 rounded border border-zinc-300 px-1 py-1 dark:border-zinc-700 dark:bg-zinc-950" /> same
                </label>
              </div>
              <textarea name="blockedDomains" rows={2} placeholder="Blocked domains (one per line or comma-separated)" aria-label="Blocked domains" className="rounded-lg border border-zinc-300 px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950" />
              <textarea name="allowlistedDomains" rows={1} placeholder="Allowlisted domains (optional)" aria-label="Allowlisted domains" className="rounded-lg border border-zinc-300 px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950" />
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="text-zinc-500">Always require approval:</span>
                {POLICY_TOOLS.map((t) => (
                  <label key={t} className="flex items-center gap-1">
                    <input type="checkbox" name={`appr_${t}`} /> {t.replace(/_/g, " ")}
                  </label>
                ))}
              </div>
              <button type="submit" className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                Create policy
              </button>
            </form>
          </Card>

          <Card title="Administrator connection" hint="Only the linked Telegram ID can approve via DM.">
            {connectionRows.length === 0 || connectionRows.every((c) => !c.adminTelegramUserId) ? (
              <p className="text-sm text-zinc-500">
                No administrator linked. Generate an admin code on the <a href="/dashboard/telegram" className="underline">Telegram page</a>.
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {connectionRows
                  .filter((c) => c.adminTelegramUserId)
                  .map((c) => (
                    <li key={c.id} className="flex items-center gap-2">
                      <span className="font-mono text-xs">{c.adminTelegramUserId}</span>
                      <span className="text-xs text-zinc-500">{c.chatTitle ?? c.telegramChatId ?? "admin only"}</span>
                      <form action={unlinkAdmin} className="inline">
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="communityId" value={selectedId} />
                        <button type="submit" className="text-xs underline">
                          Unlink
                        </button>
                      </form>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card title="Knowledge & notifications" hint="Retrieval tuning for support answers; DM preferences for approvals and failures.">
            <form action={saveCommunitySettings} className="flex flex-col gap-2 text-sm">
              <input type="hidden" name="communityId" value={selectedId} />
              <div className="flex gap-2">
                <label className="flex flex-1 items-center gap-1 text-xs">
                  Similarity ≥
                  <input name="retrievalThreshold" type="number" step="0.05" min={0} max={0.95} defaultValue={settings?.retrievalThreshold ?? 0.35} className="w-20 rounded border border-zinc-300 px-1 py-1 dark:border-zinc-700 dark:bg-zinc-950" />
                </label>
                <label className="flex flex-1 items-center gap-1 text-xs">
                  Top
                  <input name="retrievalLimit" type="number" min={1} max={10} defaultValue={settings?.retrievalLimit ?? 4} className="w-16 rounded border border-zinc-300 px-1 py-1 dark:border-zinc-700 dark:bg-zinc-950" />
                  chunks
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" name="notifyApprovals" defaultChecked={settings?.notifyApprovals ?? true} />
                DM the admin for approvals
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" name="notifyFailures" defaultChecked={settings?.notifyFailures ?? true} />
                DM the admin on execution failures
              </label>
              <button type="submit" className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                Save settings
              </button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
