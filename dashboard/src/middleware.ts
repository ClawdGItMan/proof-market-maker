import { NextResponse, type NextRequest } from "next/server";
import { verifyBasicAuth } from "@/lib/auth";

// Edge gate: every route (read panels, /api/state, and the Server Action POSTs) is
// behind operator Basic Auth. This is the first of two layers — the kill-switch
// action re-verifies independently (see app/actions.ts) so a misconfigured matcher
// can never expose the privileged write.
//
// Fail closed: if no operator credential is configured, nothing is served.

const REALM = 'Basic realm="Proof MM Ops", charset="UTF-8"';

export function middleware(req: NextRequest) {
  const operator = verifyBasicAuth(req.headers.get("authorization"));
  if (operator) return NextResponse.next();

  const configured = !!process.env.DASHBOARD_BASIC_AUTH_USER && !!process.env.DASHBOARD_BASIC_AUTH_PASSWORD;
  return new NextResponse(
    configured ? "Authentication required" : "Dashboard auth not configured (DASHBOARD_BASIC_AUTH_USER/PASSWORD)",
    { status: configured ? 401 : 503, headers: { "WWW-Authenticate": REALM } },
  );
}

// Apply to everything except Next's static assets and the favicon.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
