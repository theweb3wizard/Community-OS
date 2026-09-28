import "./load-env";
import { sql } from "drizzle-orm";

import { db, hasDatabaseUrl } from "./index";

async function main() {
  if (!hasDatabaseUrl()) {
    console.error(
      "BLOCKED: DATABASE_URL / DATABASE_URL_UNPOOLED is not set. " +
        "Provide a Neon connection string to run a real database read/write.",
    );
    process.exit(2);
  }
  const rows = (await db.execute(sql`select 1 as ok`)) as unknown as Array<{
    ok: number;
  }>;
  console.log(`DB_OK rows=${JSON.stringify(rows)}`);
}

void main();
