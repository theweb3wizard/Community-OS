import { config } from "dotenv";

// CLI scripts (drizzle-kit, tsx) do not load Next.js-style .env.local
// automatically. Import this module FIRST (before ./index) so
// DATABASE_URL is present at module evaluation time. No-op when files
// are absent; never overrides real environment variables.
config({ path: ".env.local" });
config();

export {};
