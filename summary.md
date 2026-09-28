# CommunityOS — Engineering Summary (Build Stages 1–7)

**Product:** CommunityOS is an AI-native community operations platform for
Web3 Telegram communities. It observes group activity, interprets it with
AI, and acts only within policy — routine work is automated, consequential
decisions go to human operators via dashboard and Telegram DM approvals.

**Repository:** https://github.com/theweb3wizard/Community-OS.git (`main`)
**Stack:** Next.js 16 + React 19 + TypeScript + Tailwind v4 · Neon
PostgreSQL + Drizzle ORM + pgvector · Telegram Bot API (webhooks) · Gemini
(structured decisions, answers, embeddings, summaries) with Jev (TypeSafe
decision model) as the optional structured primary. Single repo, single
database, no additional infrastructure. Designed for Vercel deployment.

---

## 1. Architecture (enforced in code, not just documented)

```text
Telegram → webhook → normalize → resolve community/member → persist
  → agent runtime → context → decision (Jev → Gemini fallback)
  → policy (AUTO / APPROVAL / ESCALATE / IGNORE) → tools → Telegram API
  → activity log → PostgreSQL
```

Governing rules, all mechanically enforced:

- The model **recommends**; the **policy engine authorizes**; only **six
  registered tools** can act (`send_reply`, `delete_message`, `warn_user`,
  `restrict_user`, `create_alert`, `escalate`). Unknown tools are rejected
  before policy stage, and the registry itself refuses them.
- Execution targets (chat / message / user IDs) always come from the
  triggering Telegram event — never from model output.
- Approvals execute **at most once** via atomic single-statement database
  claims (required because the serverless Postgres driver offers no
  interactive transactions).
- Support answers come **only** from trusted knowledge with HIGH / MEDIUM /
  LOW confidence gating; uncovered questions escalate, never invented.

## 2. What was delivered, by stage

**Stage 1 — Foundation.** App shell, operator auth (JWT sessions), dashboard
shell with truthful empty states, full 14-table schema, environment
validation, Neon connection proven with real read/write.

**Stage 2 — Telegram integration (live-tested).** Typed Bot API service
layer, secret-verified webhook, update normalization, community/member
resolution keyed on numeric Telegram IDs, message persistence, `/connect`
and `/admin` pairing flows, administrator DM channel. Verified live with a
real bot (@COMMUNITY_WIZARD_BOT) in a real test supergroup: chat bound,
member stored, messages persisted with exact Telegram IDs and timestamps,
admin linked, test DM delivered.

**Stage 3 — Agent runtime.** Event → context (bounded: community, member,
message, ≤10 recent messages, policies, deterministic signals) → decision →
policy → tool → log. Controlled tool registry, deterministic pre-checks
(blocked/allowlisted domains, repeats, flooding, admin roles, commands),
deterministic test provider (NORMAL/SPAM/PHISHING/SUPPORT/ESCALATE).

**Stage 4 — AI decision layer + trusted knowledge.** Gemini structured
decisions (validated JSON schema), Jev adapter against the published
OpenRouter Decisions API (choice + noul + score), Jev→Gemini fallback with
safe failure, semantic routing gate (trivial texts cost zero AI),
knowledge source → chunk → embed (1536-d) → pgvector → attributed
retrieval, confidence-gated support answers, deterministic community
intelligence signals with optional AI summaries.

**Stage 5 — Policy engine + approvals.** Deterministic v1 policy with risk
scoring, community overrides (strict mode, per-tool approval, thresholds,
domain lists), full approval lifecycle (pending → approved/rejected/failed/
expired), Telegram DM requests with Approve/Reject buttons, atomic claims,
forgery-safe tokens, unauthorized-attempt logging, dashboard review queue.

**Stage 6 — Operator dashboard.** Overview with live counts, operational
inbox, per-message trace view (Telegram → decision → action), moderation
history with evidence, support triage + answer log, knowledge management
(ingest, chunk inspection, delete), intelligence (observed data separated
from AI interpretation), activity search, full settings (policies,
retrieval, notifications), and a 7-step onboarding wizard. Zero fabricated
metrics.

**Stage 7 — Verification, security & polish.** Session enforcement on all
mutating actions, SSRF protection on URL ingestion, atomic pairing-code
claims, webhook hardening, plus this documentation pass.

## 3. Verification evidence

| Suite | Result | Against |
|---|---|---|
| Ingestion (27 checks) | pass | live Neon, stubbed Telegram |
| Agent runtime (38) | pass | live Neon, stubbed Telegram |
| Approvals (38) | pass | live Neon, stubbed Telegram |
| AI offline (36) | pass | no network |
| Onboarding (10) | pass | live Neon |
| Live Telegram E2E | pass | real bot, group, admin DM |
| Live Gemini core | pass | structured decisions, embeddings, retrieval |
| `tsc` / `lint` / production build | pass | — |

**Simulated (by design):** Jev→Gemini fallback chain, total AI failure,
Telegram API failures, unauthorized/forged/duplicate approvals,
spam/phishing auto-vs-approval flows.
**Blocked:** remainder of the live AI matrix (grounded answers,
escalation paths, summaries) — Gemini free tier allows 20 generate-calls/
day and it was exhausted during verification; scripted as `npm run ai:live`
for one command after reset. **Not live-tested:** Jev (no OpenRouter key
provided — adapter isolated, never claimed otherwise).

## 4. Credentials & infrastructure in use

Neon Postgres project `communityos` · Telegram bot token + webhook secret
(server env only) · Gemini API key (server env only) · Vercel deployment
(`community-os-black.vercel.app`). No secrets exist in source control
(verified). The Neon API key used during setup should already be revoked.

## 5. Limitations and risks (explicit non-goals of this build)

- **Single-operator trust model** — any login acts on all communities; no
  roles or per-community access. Demo credentials are development-only.
- **Autonomy is intentionally parked** — ingestion is live and the agent is
  proven on demand, but the runtime is not yet wired to auto-act on the
  live webhook pending approval-review maturity.
- **Gemini free tier (20/day)** needs billing at real volumes.
- Approval DMs require the admin to have started the bot; no background
  expiry sweeper (expiry resolves lazily).

## 6. Recommended next steps

1. Wire the runtime to the live webhook behind a per-community automation
   switch (default off), starting with delete-only autonomy.
2. Complete the `ai:live` matrix after quota reset; add an OpenRouter key
   to live-test Jev.
3. Replace demo auth with team accounts + roles and per-community access.
4. Enable Gemini billing; add usage/cost observability per community.
5. Product hardening: expiry sweeper, ban/unban tooling decision, mobile
   pass, onboarding analytics.
