import { Card, SectionHeader } from "@/components/ui/primitives";
import { envStatus } from "@/lib/env";

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-100 py-2 text-sm last:border-0 dark:border-zinc-800">
      <span className="text-zinc-500">{label}</span>
      <span className="font-mono text-xs text-zinc-800 dark:text-zinc-200">
        {value}
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const status = envStatus();
  return (
    <div>
      <SectionHeader
        title="Settings"
        description="Environment status, policies, and connection management. Full configuration UI lands in later prompts."
      />
      <div className="grid gap-4">
        <Card
          title="Environment"
          hint="Real values read from process.env — set them in .env.local (see .env.example)."
        >
          <StatusRow
            label="Database URL"
            value={status.hasDatabaseUrl ? "configured" : "not set"}
          />
          <StatusRow
            label="Auth secret"
            value={status.hasAuthSecret ? "configured" : "dev fallback"}
          />
          <StatusRow
            label="Demo credentials"
            value={status.hasDemoCredentials ? "custom" : "defaults"}
          />
          <StatusRow label="Node env" value={status.nodeEnv} />
        </Card>
        <Card
          title="Telegram connection"
          hint="Connection flow (bot token, admin verification) is implemented in Prompt 2+. Nothing is connected in this foundation build."
        >
          <p className="text-sm text-zinc-500">Status: not connected</p>
        </Card>
        <Card
          title="Policies"
          hint="AUTO / APPROVAL / HUMAN ONLY tiers are enforced by the policy engine in a later prompt."
        >
          <p className="text-sm text-zinc-500">
            No policies configured yet. Defaults will be seeded when community
            creation lands.
          </p>
        </Card>
      </div>
    </div>
  );
}
