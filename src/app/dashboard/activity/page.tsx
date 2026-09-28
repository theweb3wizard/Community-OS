import { EmptyState, SectionHeader } from "@/components/ui/primitives";

export default function ActivityPage() {
  return (
    <div>
      <SectionHeader
        title="Activity"
        description="Append-only log of everything the system and operators did."
      />
      <EmptyState
        title="No activity logged"
        body="The activity logger starts recording once event ingestion goes live. Every entry will show actor, event, and detail."
      />
    </div>
  );
}
