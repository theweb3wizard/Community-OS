import { EmptyState, SectionHeader } from "@/components/ui/primitives";

export default function InboxPage() {
  return (
    <div>
      <SectionHeader
        title="Inbox"
        description="Flagged messages and conversations needing operator attention."
      />
      <EmptyState
        title="Inbox is empty"
        body="No conversations have been ingested yet. The inbox populates after the Telegram connection is established in a later prompt."
      />
    </div>
  );
}
