import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
  AUTH_SECRET: z.string().min(16).optional(),
  AUTH_DEMO_EMAIL: z.string().email().optional(),
  AUTH_DEMO_PASSWORD: z.string().min(8).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Never crash imports; callers decide. Surface issues in health checks.
    console.warn("env validation warnings:", parsed.error.flatten());
    cached = {
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      AUTH_SECRET: process.env.AUTH_SECRET,
      AUTH_DEMO_EMAIL: process.env.AUTH_DEMO_EMAIL,
      AUTH_DEMO_PASSWORD: process.env.AUTH_DEMO_PASSWORD,
      NODE_ENV:
        process.env.NODE_ENV === "production" ? "production" : "development",
    };
    return cached;
  }
  cached = parsed.data;
  return cached;
}

export function envStatus() {
  const env = getEnv();
  return {
    hasDatabaseUrl: Boolean(env.DATABASE_URL ?? env.DATABASE_URL_UNPOOLED),
    hasAuthSecret: Boolean(env.AUTH_SECRET),
    hasDemoCredentials: Boolean(env.AUTH_DEMO_EMAIL && env.AUTH_DEMO_PASSWORD),
    nodeEnv: env.NODE_ENV,
  };
}
