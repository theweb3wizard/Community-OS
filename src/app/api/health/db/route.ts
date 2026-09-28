import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, hasDatabaseUrl } from "@/db";
import { envStatus } from "@/lib/env";

export async function GET() {
  const status = envStatus();
  if (!hasDatabaseUrl()) {
    return NextResponse.json(
      { ok: false, blocked: true, status, error: "DATABASE_URL is not set" },
      { status: 503 },
    );
  }
  try {
    await db.execute(sql`select 1 as ok`);
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        status,
        error: error instanceof Error ? error.message : "query failed",
      },
      { status: 500 },
    );
  }
}
