import type { AgentContext, AgentDecision } from "@/lib/agent/types";
import type { DecisionProvider } from "@/lib/agent/provider";
import { toAgentDecision } from "./actions";
import { GeminiClient } from "./gemini";
import { jevConfigFromEnv, requestJevDecision } from "./jev";
import { STRUCTURED_DECISION_JSON_SCHEMA, validateStructuredDecision } from "./structured";

function buildState(context: AgentContext): Record<string, unknown> {
  return {
    message: context.message?.text ?? context.event.text ?? "",
    sender: {
      username: context.member?.username ?? context.event.sender?.username ?? null,
      role: context.member?.role ?? "member",
    },
    chat_type: context.event.chatType,
    community: context.community.name,
    signals: {
      urls: context.signals.urls,
      blocked_domain: context.signals.blockedDomain ?? null,
      allowlisted_domain: context.signals.allowlistedDomain ?? null,
      repeated: context.signals.repeated,
      flooding: context.signals.flooding,
      is_admin: context.signals.isAdmin,
    },
    recent: context.recentMessages.slice(0, 5).map((m) => m.text),
  };
}

/** Jev: typed classification without prose. Optional — absent key = skip. */
export class JevDecisionProvider implements DecisionProvider {
  readonly name = "jev";
  static isConfigured(): boolean {
    return jevConfigFromEnv() !== null;
  }
  async decide(context: AgentContext): Promise<AgentDecision> {
    const config = jevConfigFromEnv();
    if (!config) throw new Error("jev_not_configured");
    const structured = await requestJevDecision(config, buildState(context));
    const validated = validateStructuredDecision(structured);
    if (!validated.ok) throw new Error(validated.reason);
    return toAgentDecision(validated.decision, "jev");
  }
}

function buildPrompt(context: AgentContext): string {
  const lines = [
    `Community: ${context.community.name}.`,
    `Sender role: ${context.member?.role ?? "member"}${context.signals.isAdmin ? " (administrator)" : ""}.`,
    `Message: ${JSON.stringify(context.message?.text ?? context.event.text ?? "")}`,
    `Signals: urls=[${context.signals.urls.join(", ")}]` +
      (context.signals.blockedDomain ? ` blocked_domain=${context.signals.blockedDomain}` : "") +
      (context.signals.allowlistedDomain ? ` allowlisted_domain=${context.signals.allowlistedDomain}` : "") +
      ` repeated=${context.signals.repeated} flooding=${context.signals.flooding}.`,
    `Recent context: ${JSON.stringify(context.recentMessages.slice(0, 3).map((m) => m.text))}`,
    "Classify this Telegram community message. Be conservative: when unsure between NORMAL and anything else, prefer NORMAL with lower confidence and set requiresHuman true. Never recommend restrict unless there is clear abuse.",
  ];
  return lines.join("\n");
}

/** Gemini: structured classification + reasoning summary via JSON schema. */
export class GeminiDecisionProvider implements DecisionProvider {
  readonly name = "gemini";
  constructor(private readonly client: GeminiClient = GeminiClient.fromEnv()) {}
  static isConfigured(): boolean {
    return GeminiClient.isConfigured();
  }
  async decide(context: AgentContext): Promise<AgentDecision> {
    const raw = await this.client.generateStructured(
      buildPrompt(context),
      STRUCTURED_DECISION_JSON_SCHEMA,
    );
    const validated = validateStructuredDecision(raw);
    if (!validated.ok) throw new Error(validated.reason);
    return toAgentDecision(validated.decision, "gemini");
  }
}

/** Jev → Gemini fallback. Records which provider actually decided. */
export class FallbackDecisionProvider implements DecisionProvider {
  readonly name = "fallback";
  public usedProvider: string | null = null;
  constructor(
    private readonly primary: DecisionProvider | null,
    private readonly fallback: DecisionProvider | null,
  ) {}
  async decide(context: AgentContext): Promise<AgentDecision> {
    const errors: string[] = [];
    if (this.primary) {
      try {
        const decision = await this.primary.decide(context);
        this.usedProvider = this.primary.name;
        return decision;
      } catch (error) {
        errors.push(`${this.primary.name}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    if (this.fallback) {
      try {
        const decision = await this.fallback.decide(context);
        this.usedProvider = this.fallback.name;
        return decision;
      } catch (error) {
        errors.push(`${this.fallback.name}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    throw new Error(`all_providers_failed (${errors.join("; ") || "none configured"})`);
  }
}

/** Intelligent routing gate: only messages where semantic interpretation can
 * change the outcome reach a model. Everything else stays deterministic. */
export function semanticGate(context: AgentContext): { needed: boolean; reason: string } {
  const text = (context.message?.text ?? context.event.text ?? "").trim();
  if (context.event.kind !== "message" && context.event.kind !== "edited_message") {
    return { needed: false, reason: "non_message_kind" };
  }
  if (context.signals.isControlCommand) return { needed: false, reason: "control_command" };
  if (context.event.sender?.isBot) return { needed: false, reason: "bot_sender" };
  if (text.length === 0) return { needed: false, reason: "no_text" };
  if (text.length < 4) return { needed: false, reason: "trivial_text" };
  return { needed: true, reason: "semantic_interpretation_matters" };
}

/** Provider chain from environment. Jev is optional; Gemini is the fallback. */
export function activeProviderChain(): FallbackDecisionProvider {
  const primary = JevDecisionProvider.isConfigured() ? new JevDecisionProvider() : null;
  const fallback = GeminiDecisionProvider.isConfigured() ? new GeminiDecisionProvider() : null;
  return new FallbackDecisionProvider(primary, fallback);
}
