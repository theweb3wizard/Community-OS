import { NextResponse } from "next/server";

import { db } from "@/db";
import { activityLogs } from "@/db/schema";
import { TelegramClient } from "@/lib/telegram/client";
import { normalizeUpdate } from "@/lib/telegram/normalize";
import { runPipeline } from "@/lib/telegram/pipeline";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_BODY_BYTES = 1_000_000;

// Best-effort logging: if the database itself is down, still answer 2xx so
// Telegram stops retrying a delivery we can never process right now.
async function logIngress(
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(activityLogs).values({
      communityId: null,
      actorType: "system",
      event,
      detail,
    });
  } catch {
    // ignore — the 2xx response below is the contract
  }
}

// Public endpoint (Telegram servers call it). Authentication is the
// X-Telegram-Bot-Api-Secret-Token header set via setWebhook. Responses are
// always 2xx after the secret check: Telegram retries non-2xx deliveries,
// and retrying a deterministically-unprocessable update only creates storms.
// Failures are recorded in activity_logs instead.
export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "webhook_not_configured" },
      { status: 503 },
    );
  }
  const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!timingSafeEqual(header, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await logIngress("telegram.oversized_update", { declared });
    return NextResponse.json({ ok: true, stored: false });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    await logIngress("telegram.invalid_json", {});
    return NextResponse.json({ ok: true, stored: false });
  }

  const normalized = normalizeUpdate(body);
  if (!normalized.ok) {
    await logIngress("telegram.malformed_update", { reason: normalized.reason });
    return NextResponse.json({ ok: true, stored: false });
  }

  let client: TelegramClient | undefined;
  try {
    client = TelegramClient.fromEnv();
  } catch {
    client = undefined; // persist-only mode; replies skipped, noted in outcome
  }

  try {
    const outcome = await runPipeline(normalized.event, { client });
    return NextResponse.json({ ok: true, status: outcome.status, outcome });
  } catch (error) {
    await logIngress("telegram.pipeline_error", {
      updateId: normalized.event.updateId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ ok: true, stored: false });
  }
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
