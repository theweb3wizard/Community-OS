import { EmptyState, SectionHeader } from "@/components/ui/primitives";

export default function SupportPage() {
  return (
    <div>
      <SectionHeader
        title="Support"
        description="Classified support requests routed from community activity."
      />
      <EmptyState
        title="No support issues"
        body="Support classification and trusted-knowledge answers arrive in later prompts. There is nothing to triage yet."
      />
    </div>
  );
}
