import { NextRequest } from "next/server";

export function validateSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const allowedOrigin = process.env.NEXTAUTH_URL || "http://localhost:3000";

  // Dev-only: allow requests without Origin/Referer (local debugging, tools, etc.)
  if (process.env.NODE_ENV === "development") {
    if (!origin && !referer) return true;
  }

  let allowed: URL;
  try {
    allowed = new URL(allowedOrigin);
  } catch {
    return false;
  }

  const check = origin || referer;
  if (!check) return false;

  try {
    const parsed = new URL(check);
    return parsed.origin === allowed.origin;
  } catch {
    return false;
  }
}
