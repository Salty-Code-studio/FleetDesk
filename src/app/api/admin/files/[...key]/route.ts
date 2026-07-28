import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { read } from "@/lib/admin/guard";
import { Errors } from "@/lib/http/errors";
import { getObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/files/[...key] — stream a stored object to an authenticated
 * admin, SAME-ORIGIN. The admin UI's strict CSP (img-src 'self') forbids
 * loading cross-origin Supabase URLs, so all inspection photos, signatures,
 * and contracts render through this route regardless of the active driver.
 * PDFs download with a filename; images render inline.
 */
export const GET = withRoute<{ key: string[] }>(async (req, { params }) =>
  read(req, async () => {
    const key = (params.key ?? []).join("/");
    const { data, contentType } = await getObject(key).catch(() => {
      throw Errors.notFound("File not found");
    });
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=60",
    };
    if (key.endsWith(".pdf")) {
      headers["Content-Disposition"] = `attachment; filename="${key.split("/").pop() ?? "document.pdf"}"`;
    }
    return new NextResponse(Buffer.from(data), { headers });
  }),
);
