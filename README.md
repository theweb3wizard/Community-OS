# CommunityOS

AI-native community operations for Web3 Telegram communities.

CommunityOS observes Telegram activity, interprets it with AI, and acts only
within policy. The central loop is
**OBSERVE → UNDERSTAND → DECIDE → AUTHORIZE → ACT → LOG → ESCALATE** — the
model recommends, the application authorizes. There are no unrestricted
autonomous actions.

## How it works

```text
Telegram → Bot API → webhook → normalize → resolve community/member
  → persist → agent runtime → context → decision (Jev, Gemini fallback)
  → policy (AUTO / APPROVAL / ESCALATE / IGNORE) → tools → Telegram API
  → activity log → PostgreSQL
```

- **Decisions are structured data**, never raw model text. Tool targets
  (chat, message, user) always come from the triggering event, never from
  model output.
- **Policy is the sole authority** for Telegram mutations. Corroborated
  high-confidence spam can auto-delete; restrictions, warnings, and replies
  require human approval; sensitive topics escalate to operators.
- **Approvals** reach the linked administrator as a Telegram DM with
  Approve/Reject buttons, are claimed atomically (execute-at-most-once),
  and are fully auditable on the dashboard.
- **Support answers** come only from trusted knowledge (pgvector retrieval)
  with HIGH/MEDIUM/LOW confidence gating — uncovered questions escalate
  instead of being invented.

## Stack

| Concern | Choice |
|---|---|
| App | Next.js 16 App Router, React 19, TypeScript |
| UI | Tailwind CSS v4, server components |
| Database | Neon PostgreSQL + Drizzle ORM (`neon-http`, Vercel-compatible) |
| Vectors | `pgvector` (`vector(1536)`, HNSW cosine index) |
| Auth | Operator sign-in, `jose` HS256 JWT in an httpOnly cookie |
| AI | Gemini (`@google/genai`: structured decisions, answers, embeddings, summaries) with Jev (TypeSafe decision model via OpenRouter) as the optional structured primary |
| Bot platform | Telegram Bot API (webhooks) |

Single repository, single database, no extra infrastructure. Auth uses a
minimal `jose`-based session rather than `next-auth`, whose v5 beta peer
range does not support Next 16.

## Quickstart

```bash
npm install
cp .env.example .env.local   # fill in values below
npm run dev                  # http://localhost:3000
```

Development sign-in (override in `.env.local`):

- email `operator@communityos.local`
- password `ChangeMe123!`

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon pooled connection string (app runtime) |
| `DATABASE_URL_UNPOOLED` | yes | Neon direct connection string (migrations) |
| `AUTH_SECRET` | yes (prod) | Session signing secret, min 16 chars |
| `AUTH_DEMO_EMAIL` / `AUTH_DEMO_PASSWORD` | dev | Operator credentials |
| `TELEGRAM_BOT_TOKEN` | for Telegram | Bot token from @BotFather (server only) |
| `TELEGRAM_WEBHOOK_SECRET` | for Telegram | Webhook verification secret (`A-Za-z0-9_-`, 16–256 chars) |
| `APP_URL` | for Telegram | Public https base URL (Telegram cannot reach localhost) |
| `GEMINI_API_KEY` | for AI | Google AI Studio key |
| `GEMINI_MODEL` / `GEMINI_EMBED_MODEL` | no | Defaults: `gemini-3.8-flash` / `gemini-embedding-001` |
| `JEV_API_KEY` | no | OpenRouter key for the Jev decision primary (absent = Gemini handles everything) |
| `JEV_MODEL` / `JEV_BASE_URL` | no | Defaults: `typesafe/jev-1.13` / `https://openrouter.ai` |

Never commit `.env.local`. No key is ever exposed to client code.

## Database setup

```bash
npm run db:generate   # author migrations offline into drizzle/
npx drizzle-kit migrate   # apply to Neon (needs DATABASE_URL_UNPOOLED)
npm run db:check      # live select-1 check
GET /api/health/db    # runtime DB status
```

Schema covers users, communities, Telegram connections + link codes,
members, messages, moderation/support/alert/approval/action/policy records,
knowledge sources + vector chunks, community settings, and an append-only
activity log. Telegram numeric IDs are stored as TEXT (they can exceed 32
bits); usernames are display-only, never identity keys.

## Telegram setup

1. Create a bot with @BotFather → `TELEGRAM_BOT_TOKEN`.
2. `npm run telegram:info` — verifies the token and shows group-privacy state.
3. For full message visibility, either make the bot an administrator or
   disable privacy via @BotFather `/setprivacy` (then re-add it).
4. Expose the app over public https (`APP_URL`) — deploy or tunnel —
   then `npm run telegram:webhook:set` (subscribed: `message`,
   `edited_message`, `callback_query`, `my_chat_member`).
5. Dashboard → Telegram: create a community, generate codes, send
   `/connect CODE` in the group and `/admin CODE` in bot DM, then Verify
   and Test DM.

## AI setup

- Add `GEMINI_API_KEY` for structured decisions, support answers,
  embeddings, and summaries.
- Optionally add `JEV_API_KEY` (OpenRouter) to route classifications
  through the Jev decision model first, with Gemini as automatic fallback.
- Knowledge: Dashboard → Knowledge (text/FAQ/URL/docs/policies/
  announcements). Retrieval uses cosine similarity over pgvector with
  per-community thresholds in Settings.

## Testing

| Command | Coverage |
|---|---|
| `npm run telegram:test` | Ingestion: normalize, resolve, persist, dedupe, link codes, callbacks (27) |
| `npm run agent:test` | Runtime: all classifications, policy gating, failures, tool safety (38) |
| `npm run approvals:test` | Approvals: auto/approve/reject/unauthorized/duplicate/human-only/failure (38) |
| `npm run ai:test` | Chunking, schemas, Jev mapping, routing gate, fallback, SSRF guards (36) |
| `npm run ai:live` | Live Gemini + Neon matrix (needs key; skips cleanly without) |
| `npm run onboarding:test` | Fresh-community flow + message trace (10) |
| `npx tsc --noEmit` · `npm run lint` · `npm run build` | Type, lint, production build |

All suites run against real Neon with stubbed external APIs and clean up
after themselves. Test markers (`[spam-test]` etc.) drive the deterministic
provider — test-only triggers, never production logic.

## Deployment

Designed for Vercel: no custom server, no TCP dependencies
(`drizzle-orm/neon-http` everywhere). Set all environment variables in the
project settings, deploy, then register the webhook against the public URL.
Run migrations against Neon before or after deploy.

## Security model

- Webhook verified by secret header (timing-safe); 401 without it; always
  2xx afterwards so Telegram never retry-storms poison updates; 1 MB body
  cap; best-effort logging.
- Every mutating dashboard action requires a session; approval callbacks
  require the linked administrator's Telegram ID plus an unguessable
  per-approval token; claims are atomic single-statement updates.
- Knowledge URL fetching is SSRF-guarded (public DNS only, default ports).
- All SQL parameterized; all rendering React-escaped.

## Limitations

- **Single-operator trust model.** Any signed-in operator acts on all
  communities; no roles or per-community membership. Demo credentials are
  development-only.
- **The runtime is not wired to the live webhook.** Ingestion persists and
  the agent is proven on demand, but autonomous Telegram actions run via
  tests/operations — deliberate until approval review matures further.
- **Gemini free tier is 20 generate-calls/day**; heavier use needs billing.
- **Jev is not live-tested** without an OpenRouter key/credit.
- Approval DMs require the admin to have started the bot; expired approvals
  resolve lazily on decision.
