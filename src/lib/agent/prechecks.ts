// Pure deterministic helpers. No I/O, no Telegram, no model calls —
// trivially unit-testable. Used by the context loader.

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const CONTROL_COMMANDS = new Set([
  "/connect",
  "/admin",
  "/start",
  "/help",
  "/approve",
  "/reject",
]);

export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(new Set(text.match(URL_RE) ?? [])).slice(0, 10);
}

export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function matchDomain(
  urls: string[],
  list: string[],
): string | undefined {
  const wanted = new Set(list.map((d) => d.toLowerCase()));
  for (const u of urls) {
    const host = domainOf(u);
    if (!host) continue;
    // Match exact host or any parent domain (sub.evil.example -> evil.example).
    const parts = host.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      if (wanted.has(parts.slice(i).join("."))) return parts.slice(i).join(".");
    }
  }
  return undefined;
}

/** Same non-empty text appearing >= threshold times in recent messages. */
export function detectRepeat(texts: Array<string | null>, threshold = 3): boolean {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const key = (t ?? "").trim().toLowerCase();
    if (!key) continue;
    const n = (counts.get(key) ?? 0) + 1;
    if (n >= threshold) return true;
    counts.set(key, n);
  }
  return false;
}

/** >= threshold messages from anyone in the recent window counts as flooding. */
export function detectFlood(recentCount: number, threshold = 10): boolean {
  return recentCount >= threshold;
}

export function isControlCommand(text: string | null | undefined): boolean {
  if (!text) return false;
  const first = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  return CONTROL_COMMANDS.has(first);
}

export function truncate(text: string | null, max = 300): string | null {
  if (text == null) return null;
  return text.length > max ? text.slice(0, max) : text;
}
