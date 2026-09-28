import { redirect } from "next/navigation";

import {
  createSessionToken,
  getSession,
  setSessionCookie,
  verifyDemoCredentials,
} from "@/lib/auth";

async function loginAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const user = await verifyDemoCredentials(email, password);
  if (!user) redirect("/login?error=invalid");
  const token = await createSessionToken(user);
  await setSessionCookie(token);
  redirect("/dashboard");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/dashboard");
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
        CommunityOS
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Foundation build: local operator sign-in. OAuth / team accounts land in
        a later prompt.
      </p>
      {params.error === "invalid" ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          Invalid email or password.
        </p>
      ) : null}
      <form action={loginAction} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="operator@communityos.local"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Sign in
        </button>
      </form>
      <p className="mt-6 text-xs text-zinc-400">
        Local default: <code>operator@communityos.local</code> /{" "}
        <code>ChangeMe123!</code> (override with AUTH_DEMO_EMAIL /
        AUTH_DEMO_PASSWORD). Change these before any shared deployment.
      </p>
    </main>
  );
}
