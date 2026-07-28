import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { Errors } from "@/lib/http/errors";
import { env } from "@/env";
import { getObject, isObjectNotFoundError } from "@/lib/storage";
import { verifyLocalSignature } from "@/lib/storage/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dev/storage/[...key]?exp=<epoch-seconds>&sig=<hmac-hex>
 * Serves LOCAL-driver objects behind an HMAC-signed, expiring link — the dev
 * stand-in for Supabase signed URLs. Hard-404s unless STORAGE_DRIVER=local, so
 * it does not exist in a Supabase-backed deployment.
 */
export const GET = withRoute<{ key: string[] }>(async (req, { params }) => {
  if (env.STORAGE_DRIVER !== "local") throw Errors.notFound();
  const key = (params.key ?? []).join("/");
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!verifyLocalSignature(key, exp, sig)) throw Errors.forbidden("This link is invalid or has expired");
  const { data, contentType } = await getObject(key).catch((e: unknown) => {
    // Only a GENUINE driver not-found becomes a 404 -- see the admin files
    // route for the full rationale. Everything else propagates unchanged so
    // it surfaces as a 500 (or its own real status) and logs at error level.
    if (isObjectNotFoundError(e)) throw Errors.notFound("File not found", e);
    throw e;
  });
  return new NextResponse(Buffer.from(data), {
    headers: { "Content-Type": contentType, "Cache-Control": "private, no-store" },
  });
});
