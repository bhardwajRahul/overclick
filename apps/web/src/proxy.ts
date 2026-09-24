import { NextResponse, type NextRequest } from "next/server";

/** Where a link that cannot be decoded is sent: a token no invitation has. */
const UNREADABLE_INVITE = "/invite/invalid";

/**
 * An invite link mangled into a malformed escape (a lone `%`, a cut `%E0%A4`)
 * never reaches the invite page: Next decodes the `[token]` segment before any
 * page code runs, fails, and answers a bare 500 (OCL-227). Such a link is
 * simply an invalid invitation, so the browser is sent to the page that
 * already says so, with the same words a made-up link gets.
 */
export function proxy(request: NextRequest) {
  const { pathname } = new URL(request.url);
  const segment = pathname.slice("/invite/".length);
  try {
    decodeURIComponent(segment);
    return NextResponse.next();
  } catch {
    // A redirect, not a rewrite: a rewrite keeps the original URL, and Next
    // decodes the params from that one and fails all the same.
    return NextResponse.redirect(new URL(UNREADABLE_INVITE, request.url));
  }
}

export const config = {
  matcher: "/invite/:path*",
};
