import { EmptyState, SectionHeader } from "@/components/ui/primitives";

export default function IntelligencePage() {
  return (
    <div>
      <SectionHeader
        title="Intelligence"
        description="Recurring problems, emerging issues, and community summaries."
      />
      <EmptyState
        title="No intelligence yet"
        body="Summaries and trend detection require live community activity plus the AI providers. Reports will appear here once connected."
      />
    </div>
  );
}
