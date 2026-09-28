import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

// NOTE: `@neondatabase/serverless`'s `neon()` validates the connection string
// eagerly at module evaluation, which would crash `next build` (page data
// collection) when no DATABASE_URL is set. So we only construct it when a
// real URL exists; otherwise we hand Drizzle a stub client that throws only
// when a query is actually attempted. All query paths must check
// `hasDatabaseUrl()` first (see /api/health/db).
const connectionString =
  process.env.DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED;

function missingDatabaseClient(): never {
  throw new Error(
    "DATABASE_URL / DATABASE_URL_UNPOOLED is not set. Add a Neon connection string to .env.local (see .env.example).",
  );
}

// Drizzle only wraps the client at construction; no query runs until used.
const stubClient = new Proxy(missingDatabaseClient, {
  get: () => missingDatabaseClient,
  apply: () => Promise.reject(missingDatabaseClient()),
}) as unknown as ReturnType<typeof neon>;

const client = connectionString ? neon(connectionString) : stubClient;

export const db = drizzle({ client, schema });

export function hasDatabaseUrl(): boolean {
  return Boolean(connectionString);
}
