import { EmptyState, SectionHeader } from "@/components/ui/primitives";

export default function ApprovalsPage() {
  return (
    <div>
      <SectionHeader
        title="Approvals"
        description="Actions the agent proposed that need a human decision."
      />
      <EmptyState
        title="Nothing awaiting approval"
        body="Warnings, restrictions, and sensitive responses will queue here with Approve / Reject actions once the approval system lands."
      />
    </div>
  );
}
