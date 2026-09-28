import { EmptyState, SectionHeader } from "@/components/ui/primitives";

export default function ModerationPage() {
  return (
    <div>
      <SectionHeader
        title="Moderation"
        description="Spam, scam/phishing, and rule-violation events with policy decisions."
      />
      <EmptyState
        title="No moderation events"
        body="Deterministic checks, the decision provider, and the policy engine land in later prompts. Nothing has been moderated yet."
      />
    </div>
  );
}
