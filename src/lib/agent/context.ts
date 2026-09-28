import { randomUUID } from "node:crypto";

import type { NormalizedEvent } from "@/lib/telegram/normalize";
import {
  detectFlood,
  detectRepeat,
  extractUrls,
  isControlCommand,
  matchDomain,
  truncate,
} from "./prechecks";
import type { AgentStore, PolicyRules } from "./store";
import type { AgentContext } from "./types";

const RECENT_LIMIT = 10;
const TEXT_TRUNCATE = 300;

function mergedRules(
  policies: Array<{ rules: Record<string, unknown> }>,
): PolicyRules & { floodThreshold: number; repeatThreshold: number } {
  const blocked = new Set<string>();
  const allowed = new Set<string>();
  let floodThreshold = 10;
  let repeatThreshold = 3;
  for (const p of policies) {
    const r = p.rules as Partial<PolicyRules>;
    for (const d of r.blockedDomains ?? []) blocked.add(String(d).toLowerCase());
    for (const d of r.allowlistedDomains ?? []) allowed.add(String(d).toLowerCase());
    if (typeof r.floodThreshold === "number") floodThreshold = r.floodThreshold;
    if (typeof r.repeatThreshold === "number") repeatThreshold = r.repeatThreshold;
  }
  return {
    blockedDomains: [...blocked],
    allowlistedDomains: [...allowed],
    floodThreshold,
    repeatThreshold,
  };
}

/** Loads bounded context for one event. Throws on missing community so the
 * runtime can reject the cycle explicitly (never a silent pass). */
export async function loadContext(
  event: NormalizedEvent,
  store: AgentStore,
): Promise<AgentContext> {
  const cycleId = randomUUID();
  const community = await store.findCommunityByChat(event.chatId);
  if (!community) throw new Error(`unknown_community chat=${event.chatId}`);

  const policies = await store.activePolicies(community.id);
  const rules = mergedRules(policies);

  let member: AgentContext["member"];
  if (event.sender && event.kind !== "callback_query") {
    const found = await store.findMember(community.id, event.sender.id);
    if (found) member = found;
  }

  let message: AgentContext["message"];
  if (event.messageId !== undefined) {
    const found = await store.findMessage(community.id, String(event.messageId));
    if (found) message = found;
  }

  const recentRaw = await store.recentMessages(community.id, RECENT_LIMIT);
  const recentMessages = recentRaw.map((m) => ({
    ...m,
    text: truncate(m.text, TEXT_TRUNCATE),
  }));

  const text = message?.text ?? event.text ?? null;
  const urls = extractUrls(text);
  const recentTexts = recentRaw.map((m) => m.text);

  const adminId = await store.adminTelegramId(community.id);
  const isAdmin =
    (event.sender ? event.sender.id === adminId : false) ||
    member?.role === "admin" ||
    member?.role === "owner";

  return {
    cycleId,
    community,
    member,
    message,
    recentMessages,
    policies: policies.map((p) => ({ id: p.id, name: p.name, rules: p.rules })),
    signals: {
      isAdmin,
      isControlCommand: isControlCommand(text),
      urls,
      blockedDomain: matchDomain(urls, rules.blockedDomains ?? []),
      allowlistedDomain: matchDomain(urls, rules.allowlistedDomains ?? []),
      repeated: detectRepeat(recentTexts, rules.repeatThreshold),
      flooding: detectFlood(recentRaw.length, rules.floodThreshold),
    },
    event,
  };
}
