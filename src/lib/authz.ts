import { redirect } from "next/navigation";

import { getSession } from "./auth";

/**
 * Server-action / route-handler guard. The dashboard layout redirects
 * unauthenticated page loads, but server actions are independently callable
 * endpoints — every mutating action must call this first. Throws a redirect
 * to /login when no valid session exists.
 */
export async function requireOperator() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
