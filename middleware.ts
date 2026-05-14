import { NextResponse, type NextRequest } from "next/server";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

function isLoopback(req: NextRequest): boolean {
  const forwarded = req.headers.get("x-forwarded-for");
  const candidates = [
    forwarded?.split(",")[0]?.trim(),
    req.headers.get("x-real-ip"),
    // NextRequest.ip exists at runtime on the edge, but is typed loosely.
    (req as unknown as { ip?: string }).ip,
  ].filter(Boolean) as string[];

  if (candidates.length === 0) {
    // Local dev / direct connection often has no forwarded headers.
    return true;
  }
  return candidates.every((c) => LOOPBACK_HOSTS.has(c));
}

export function middleware(req: NextRequest) {
  // `MAGENTA_LOCAL_ONLY` is read on each request so flipping it doesn't need a rebuild
  // in dev. In production, the bundler inlines `process.env.MAGENTA_LOCAL_ONLY` so the
  // check still works.
  const enabled = (process.env.MAGENTA_LOCAL_ONLY ?? "true").toLowerCase() !== "false";
  if (!enabled) return NextResponse.next();

  if (!isLoopback(req)) {
    return new NextResponse("Forbidden: MAGENTA_LOCAL_ONLY is enabled.", { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
