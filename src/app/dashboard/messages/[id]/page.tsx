import Link from "next/link";

import { EmptyState, SectionHeader } from "@/components/ui/primitives";
import { Card } from "@/components/ui/primitives";
import { getMessageContext } from "@/lib/dashboard/queries";

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <span className="text-zinc-500">{k}:</span>
      <span className="font-mono text-xs break-all">{v}</span>
    </div>
  );
}

export default async function MessagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await getMessageContext(id);
  if (!ctx) {
    return (
      <div>
        <SectionHeader title="Message" description="Full trace of one Telegram event through the system." />
        <EmptyState title="Message not found" body="It may have been deleted." />
      </div>
    );
  }
  const { message, member, community, actions, approvalsList } = ctx;
  return (
    <div>
      <SectionHeader
        title="Message trace"
        description="Telegram → message → agent → decision → policy → action/approval → activity."
      />
      <div className="grid gap-4">
        <Card title="Telegram message" hint={`Received ${message.createdAt.toISOString()}`}>
          <p className="whitespace-pre-wrap text-sm">{message.text ?? "(no text)"}</p>
          <div className="mt-3 flex flex-col gap-1">
            <KV k="telegram id" v={message.telegramMessageId ?? "—"} />
            <KV k="sent at (Telegram)" v={message.sentAt?.toISOString() ?? "—"} />
            <KV k="kind" v={message.kind} />
          </div>
        </Card>
        <Card title="Sender & community">
          <div className="flex flex-col gap-1">
            <KV k="sender" v={member ? `${member.username ? `@${member.username} ` : ""}(${member.telegramUserId})` : "unknown"} />
            <KV k="role" v={member?.role ?? "—"} />
            <KV k="community" v={community?.name ?? message.communityId} />
          </div>
        </Card>
        <Card title={`Agent actions (${actions.length})`} hint="Every tool invocation tied to this message.">
          {actions.length === 0 ? (
            <p className="text-sm text-zinc-500">No agent actions reference this message.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {actions.map((a) => {
                const d = (a.detail ?? {}) as Record<string, unknown>;
                return (
                  <li key={a.id} className="rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                    <span className="font-mono rounded bg-zinc-100 px-1 dark:bg-zinc-900">{a.status}</span>{" "}
                    <span className="font-semibold">{a.kind}</span>{" "}
                    <span className="text-zinc-500">
                      {typeof d.classification === "string" ? `· ${d.classification}` : ""}
                      {typeof d.reason === "string" ? ` · ${d.reason}` : ""}
                      {typeof d.error === "string" ? ` · error: ${d.error}` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title={`Approvals (${approvalsList.length})`} hint="Human decisions tied to this message.">
          {approvalsList.length === 0 ? (
            <p className="text-sm text-zinc-500">No approvals reference this message.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {approvalsList.map((a) => (
                <li key={a.id} className="text-xs">
                  <Link href="/dashboard/approvals" className="underline">
                    {a.title}
                  </Link>{" "}
                  <span className="font-mono rounded bg-zinc-100 px-1 dark:bg-zinc-900">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
