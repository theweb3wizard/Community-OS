import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const SESSION_COOKIE = "communityos_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

function getSecret(): Uint8Array {
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv && fromEnv.length >= 16) return new TextEncoder().encode(fromEnv);
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET is required in production (min 16 chars). Generate one with: openssl rand -base64 32",
    );
  }
  // Dev-only fallback so `next build` / local dev work without secrets.
  // Never used in production (see guard above).
  return new TextEncoder().encode("dev-only-insecure-secret-change-me-000000");
}

function demoCredentials(): { email: string; password: string; hash?: string } {
  return {
    email: process.env.AUTH_DEMO_EMAIL ?? "operator@communityos.local",
    password: process.env.AUTH_DEMO_PASSWORD ?? "ChangeMe123!",
    hash: process.env.AUTH_DEMO_PASSWORD_HASH,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyDemoPassword(
  password: string,
): Promise<SessionUser | null> {
  return verifyDemoCredentials(
    demoCredentials().email,
    password,
  );
}

export async function verifyDemoCredentials(
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const demo = demoCredentials();
  if (email.toLowerCase() !== demo.email.toLowerCase()) return null;
  if (demo.hash && demo.hash.startsWith("$2")) {
    const ok = await bcrypt.compare(password, demo.hash);
    if (!ok) return null;
  } else if (!timingSafeEqual(password, demo.password)) {
    return null;
  }
  return { id: "demo-operator", email: demo.email, name: "Operator" };
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecret());
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const email = typeof payload.email === "string" ? payload.email : null;
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (!email || !sub) return null;
    return {
      id: sub,
      email,
      name: typeof payload.name === "string" ? payload.name : "Operator",
    };
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
