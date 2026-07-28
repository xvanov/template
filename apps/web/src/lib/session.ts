import { headers } from "next/headers";
import { auth } from "@repo/auth";

/** The current session in a Server Component / Route Handler, or null. */
export async function getServerSession() {
  return auth.api.getSession({ headers: await headers() });
}
