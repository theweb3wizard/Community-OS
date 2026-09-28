# CommunityOS — Foundation (Prompt 1)

AI-native community operations for Web3 Telegram communities.

Central loop: **OBSERVE → UNDERSTAND → DECIDE → AUTHORIZE → ACT → LOG → ESCALATE.**
The AI recommends; the application authorizes. No unrestricted autonomous actions.

> Scope of this build (Prompt 1): application foundation only — Next.js +
> TypeScript + Tailwind shell, auth foundation, dashboard shell with truthful
> empty states, Neon/Drizzle schema, env plumbing. **No Telegram agent, no AI
> providers yet.** Those land in Prompts 2–7.

## Stack (verified against official docs, Sep 2026)

| Concern | Choice | Source |
|---|---|---|
| App | Next.js 16.3.6 App Router, React 19, TypeScript 5 | `create-next-app@latest`, Next.js docs |
| CSS | Tailwind CSS v4, CSS-first (`@import "tailwindcss"`, `@tailwindcss/postcss`) | Tailwind v4 Next.js guide |
| DB | Neon PostgreSQL (`DATABASE_URL`), pooled for app / direct for migrations | Neon “Connect from any app”, pooling, Drizzle-Neon guides |
| ORM | Drizzle ORM (`drizzle-orm/neon-http` over `@neondatabase/serverless`) — Vercel-compatible, no TCP needed | Drizzle “Connect Neon” docs |
| Vectors | `pgvector` (`vector(1536)` + HNSW cosine index; `CREATE EXTENSION vector` migration) | Drizzle pgvector guide |
| Auth (foundation) | Local operator sign-in: `jose` HS256 JWT in httpOnly cookie + demo credentials from env. OAuth/teams deferred. | `jose` + Next.js server-component pattern |
| Env | `zod` validation (`src/lib/env.ts`), never throws at import | — |

### Notable decision: no `next-auth` in Prompt 1

`next-auth@5.0.0-beta.29` declares peer `next@^14 || ^15`, which conflicts
with the scaffolded Next 16.3.6 (verified via `npm ERESOLVE`). Rather than
force a broken peer tree, Prompt 1 uses a minimal `jose`-based session — fully
compatible with Next 16 and Vercel serverless. Auth.js (or equivalent) can be
adopted in a later prompt once it supports Next 16.

No Pinecone/Qdrant/Redis/Mongo, no separate backend service, no Discord.

## Quickstart

```bash
npm install
cp .env.example .env.local   # then fill in DATABASE_URL (Neon Console → Connect)
npm run dev                  # http://localhost:3000
```

Demo sign-in (dev defaults, override in `.env.local`):

- email `operator@communityos.local`
- password `ChangeMe123!`

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | local dev server |
| `npm run build` | production build |
| `npm run lint` | eslint |
| `npx tsc --noEmit` | typecheck |
| `npm run db:generate` | generate Drizzle SQL (works offline) |
| `npm run db:push` / `db:migrate` | apply schema (needs `DATABASE_URL*`) |
| `npm run db:check` | real `select 1` read check (needs `DATABASE_URL*`) |
| `GET /api/health/db` | runtime DB status JSON |

## Data model (`src/db/schema.ts`)

`users, communities, telegram_connections, members, messages,
moderation_events, support_issues, knowledge_sources (+ vector
knowledge_chunks), alerts, approvals, agent_actions, policies, activity_logs`,
plus Prompt 2 plumbing: `community_link_codes` (single-use `/connect` +
`/admin` pairing codes) and `processed_updates` (webhook redelivery dedupe).
`knowledge_chunks.embedding` is `vector(1536)` with an HNSW cosine index.
Telegram numeric IDs are stored as TEXT (Bot API IDs can exceed 32 bits);
usernames are display-only, never identity keys.

## Telegram (Prompt 2: real Bot API integration)

Verified against the official Bot API reference + webhooks guide (Bot API
10.x, Sep 2026). Key behaviors the implementation depends on:

- Webhook delivery is HTTPS POST of an `Update` to `setWebhook(url)`; ports
  443/80/88/8443; non-2xx responses are retried. The handler therefore always
  returns 2xx after secret verification and records failures in
  `activity_logs` instead of relying on retries.
- `secret_token` (1–256 chars `[A-Za-z0-9_-]`) arrives as the
  `X-Telegram-Bot-Api-Secret-Token` header and is compared timing-safely.
- **Privacy mode is ON by default**: in groups the bot only sees
  commands/replies/mentions unless privacy is disabled via @BotFather
  `/setprivacy` (then re-add the bot) or the bot is an administrator.
- Bots never receive other bots' messages; `my_chat_member` reports the bot
  being added/removed; every `callback_query` must be answered.
- Group → supergroup migration issues a new chat id (`migrate_to_chat_id`) —
  the pipeline moves the community binding so history stays attached.

Setup:

1. Create a bot with @BotFather → `TELEGRAM_BOT_TOKEN` in `.env.local`.
2. `TELEGRAM_WEBHOOK_SECRET` (16–256 chars, `A-Za-z0-9_-`) in `.env.local`.
3. `npm run telegram:info` — verifies token, shows privacy state + webhook.
4. Expose the app over public https (`APP_URL`) — deploy or tunnel — then
   `npm run telegram:webhook:set` (subscribed updates: `message`,
   `edited_message`, `callback_query`, `my_chat_member`).
5. Dashboard → Telegram: create community → generate codes → `/connect CODE`
   in the group, `/admin CODE` in bot DM → Verify + Test DM.

Service layer (`src/lib/telegram/client.ts`) exposes only curated methods
(send/reply/edit/delete/restrict/admin-notify/callback-answer/verification);
there is no generic "call any Bot API method" path for the AI layer.
Pipeline stages (`src/lib/telegram/pipeline.ts`): receive → normalize →
resolve community → resolve member → persist → process (commands/membership).
Approval/rejection callback *execution* is intentionally deferred to Prompt 3.

## Routes

- `/` landing · `/login` sign-in · `/dashboard/*` (protected, redirects to
  `/login` when unauthenticated): overview, inbox, moderation, support,
  knowledge, intelligence, approvals, activity, telegram, settings.
- `POST /api/telegram/webhook` — secret-guarded Telegram ingress.
- All dashboard pages render intentional, truthful empty states — no fake
  metrics.

## Architecture (target, Prompts 2+)

```text
Telegram → Bot API → Next.js ingest → deterministic checks → context/knowledge
→ DecisionProvider (Jev, Gemini fallback) → structured decision
→ PolicyEngine (AUTO / APPROVAL / HUMAN ONLY) → executor → Telegram API
→ activity log → PostgreSQL. Admin DMs carry Approve/Reject callbacks.
```

Knowledge: trusted sources → chunk → embed → `pgvector` → retrieve → Gemini.
The agent is the orchestration layer (`src/lib/*`); model providers are
services behind an abstraction — never the authority.

## Secrets

Never committed. `.env.local` is gitignored; see `.env.example`. No API keys
in client code. The Telegram bot token lives only in server env
(`TELEGRAM_BOT_TOKEN`); the database stores bot usernames and numeric chat /
user IDs, never the token.
