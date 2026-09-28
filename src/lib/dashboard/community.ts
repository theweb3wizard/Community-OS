import { db } from "@/db";
import { communities } from "@/db/schema";

export interface CommunityOption {
  id: string;
  name: string;
}

export async function getCommunities(): Promise<CommunityOption[]> {
  const rows = await db.select({ id: communities.id, name: communities.name }).from(communities);
  return rows;
}

export async function resolveCommunity(
  requestedId?: string,
): Promise<{ options: CommunityOption[]; selectedId: string | null }> {
  const options = await getCommunities();
  const selectedId =
    requestedId && options.some((o) => o.id === requestedId)
      ? requestedId
      : (options[0]?.id ?? null);
  return { options, selectedId };
}
