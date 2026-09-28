import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

// ---------------------------------------------------------------------------
// Users & communities
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // Nullable to allow future OAuth-only accounts. Foundation auth uses a
  // seeded bcrypt hash when env demo credentials are configured.
  passwordHash: text("password_hash"),
  name: text("name"),
  ...timestamps,
});

export const communities = pgTable("communities", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").references(() => users.id),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Telegram connections & members & messages
// ---------------------------------------------------------------------------

export const telegramConnections = pgTable(
  "telegram_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .references(() => communities.id)
      .notNull(),
    // Never store a raw bot token in the database. The single deployment-wide
    // token lives in TELEGRAM_BOT_TOKEN (server env only); this column records
    // which bot username the chat was linked with, for operator visibility.
    botUsername: text("bot_username"),
    telegramChatId: text("telegram_chat_id"),
    chatTitle: text("chat_title"),
    chatType: text("chat_type"),
    adminTelegramUserId: text("admin_telegram_user_id"),
    status: text("status").notNull().default("disconnected"),
    config: jsonb("config").$type<Record<string, unknown>>().default({}),
    ...timestamps,
  },
  (t) => [unique("telegram_connections_chat_unique").on(t.telegramChatId)],
);

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .references(() => communities.id)
      .notNull(),
    telegramUserId: text("telegram_user_id"),
    username: text("username"),
    firstName: text("first_name"),
    role: text("role").notNull().default("member"),
    isBanned: boolean("is_banned").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("members_community_user_unique").on(t.communityId, t.telegramUserId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .references(() => communities.id)
      .notNull(),
    memberId: uuid("member_id").references(() => members.id),
    telegramMessageId: text("telegram_message_id"),
    text: text("text"),
    kind: text("kind").notNull().default("unclassified"),
    // Authoritative send time from Telegram (Unix `date`), distinct from
    // `created_at` (ingest time).
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique("messages_community_tgid_unique").on(t.communityId, t.telegramMessageId),
  ],
);

// ---------------------------------------------------------------------------
// Telegram ingestion plumbing
// ---------------------------------------------------------------------------

/** Single-use pairing codes: `/connect CODE` in a group, `/admin CODE` in DM. */
export const communityLinkCodes = pgTable(
  "community_link_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .references(() => communities.id)
      .notNull(),
    code: text("code").notNull().unique(),
    purpose: text("purpose").notNull().default("connect"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

/** Processed Telegram update_ids — insert-or-ignore gives us redelivery safety. */
export const processedUpdates = pgTable("processed_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ---------------------------------------------------------------------------
// Operations: moderation, support, alerts, approvals, actions, policies
// ---------------------------------------------------------------------------

export const moderationEvents = pgTable("moderation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id)
    .notNull(),
  messageId: uuid("message_id").references(() => messages.id),
  memberId: uuid("member_id").references(() => members.id),
  category: text("category").notNull().default("unclassified"),
  action: text("action").notNull().default("none"),
  status: text("status").notNull().default("logged"),
  reason: text("reason"),
  confidence: integer("confidence"),
  ...timestamps,
});

export const supportIssues = pgTable("support_issues", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id)
    .notNull(),
  memberId: uuid("member_id").references(() => members.id),
  title: text("title").notNull(),
  body: text("body"),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("normal"),
  ...timestamps,
});

export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id)
    .notNull(),
  severity: text("severity").notNull().default("info"),
  title: text("title").notNull(),
  body: text("body"),
  status: text("status").notNull().default("open"),
  ...timestamps,
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id)
    .notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by"),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  ...timestamps,
});

export const agentActions = pgTable("agent_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id)
    .notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("proposed"),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
  telegramMessageId: text("telegram_message_id"),
  ...timestamps,
});

export const policies = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id)
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  rules: jsonb("rules").$type<Record<string, unknown>>().default({}),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Trusted knowledge (chunked + embedded for pgvector retrieval)
// ---------------------------------------------------------------------------

export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id)
    .notNull(),
  kind: text("kind").notNull().default("text"),
  title: text("title").notNull(),
  uri: text("uri"),
  content: text("content"),
  ...timestamps,
});

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .references(() => communities.id)
      .notNull(),
    sourceId: uuid("source_id").references(() => knowledgeSources.id),
    content: text("content").notNull(),
    // 1536 dims matches common embedding models; adjustable per source later.
    embedding: vector("embedding", { dimensions: 1536 }),
    tokenCount: integer("token_count"),
    ...timestamps,
  },
  (table) => [
    index("knowledge_chunks_embedding_hnsw").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

// ---------------------------------------------------------------------------
// Per-community operator settings
// ---------------------------------------------------------------------------

export const communitySettings = pgTable("community_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id)
    .notNull()
    .unique(),
  retrievalThreshold: real("retrieval_threshold").notNull().default(0.35),
  retrievalLimit: integer("retrieval_limit").notNull().default(4),
  notifyApprovals: boolean("notify_approvals").notNull().default(true),
  notifyFailures: boolean("notify_failures").notNull().default(true),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Append-only activity log
// ---------------------------------------------------------------------------

export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id").references(() => communities.id),
  actorType: text("actor_type").notNull().default("system"),
  actorId: text("actor_id"),
  event: text("event").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
