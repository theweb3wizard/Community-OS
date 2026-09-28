import { EmptyState, SectionHeader } from "@/components/ui/primitives";

export default function KnowledgePage() {
  return (
    <div>
      <SectionHeader
        title="Knowledge"
        description="Trusted sources: text, URLs, FAQs, docs, policies, announcements."
      />
      <EmptyState
        title="No knowledge sources"
        body="Ingestion, chunking, embeddings (pgvector), and retrieval are implemented in a later prompt. Add sources then; answers will cite only this trusted store."
      />
    </div>
  );
}
