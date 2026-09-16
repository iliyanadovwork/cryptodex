import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// import components
import { authRoutes, protectedRoutes, matchesRoute } from "@/components/Router/routes";
const PUBLIC_FILE = /\.(.*)$/;

export function middleware(request: NextRequest) {
  if (
    request.nextUrl.pathname.startsWith("/_next") ||
    request.nextUrl.pathname.startsWith("/socket.io") ||
    request.nextUrl.pathname.includes("/api/") ||
    PUBLIC_FILE.test(request.nextUrl.pathname)
  ) {
    return;
  }

  const currentUser = request.cookies.get("loggedin");
  if (
    matchesRoute(protectedRoutes, request.nextUrl.pathname) &&
    !currentUser?.value
  ) {
    request.cookies.delete("loggedin");
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("loggedin");
    return response;
  }

  if (matchesRoute(authRoutes, request.nextUrl.pathname) && currentUser?.value) {
    return NextResponse.redirect(new URL("/", request.url));
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - favicon.ico (favicon file)
     */
    "/((?!api|_next|favicon.ico|socket.io).*)",
  ],
};
