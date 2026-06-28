import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { earlyAccessLeads } from "@/lib/db/schema";
import { POST } from "@/app/api/early-access/route";

let db: Awaited<ReturnType<typeof getDb>>;

/** Build a JSON POST Request plus the Next route context withRoute expects.
 *  Sends an allowed Origin so it passes the CSRF origin guard; pass a different
 *  origin to exercise rejection. */
function post(payload: unknown, origin = "http://localhost:3000") {
  const req = new Request("http://localhost:3000/api/early-access", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(payload),
  });
  return POST(req, { params: Promise.resolve({}) });
}

describe("POST /api/early-access — funnel lead capture", () => {
  beforeAll(async () => {
    await runMigrations();
    db = await getDb();
  });

  it("stores a valid lead and returns 201 (email lowercased)", async () => {
    const res = await post({
      name: "Tex Rivera",
      email: "Tex@Example.COM",
      company: "Tex Cars Aruba",
      country: "AW",
      fleetSize: "26-50",
      message: "Keen to lock early-adopter pricing.",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await db
      .select()
      .from(earlyAccessLeads)
      .where(eq(earlyAccessLeads.email, "tex@example.com"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe("Tex Rivera");
    expect(row.email).toBe("tex@example.com"); // lowercased on insert
    expect(row.company).toBe("Tex Cars Aruba");
    expect(row.country).toBe("AW");
    expect(row.fleetSize).toBe("26-50");
    expect(row.message).toBe("Keen to lock early-adopter pricing.");
    expect(row.source).toBe("early-access");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("applies field defaults when optional fields are omitted", async () => {
    const res = await post({ name: "Min Lead", email: "min@example.com" });
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(earlyAccessLeads)
      .where(eq(earlyAccessLeads.email, "min@example.com"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.company).toBe("");
    expect(row.country).toBe("");
    expect(row.fleetSize).toBe("");
    expect(row.message).toBe("");
    expect(row.source).toBe("early-access");
  });

  it("rejects an invalid email with 422 and writes no row", async () => {
    const res = await post({ name: "Bad Email", email: "not-an-email" });
    expect(res.status).toBe(422);

    const rows = await db.select().from(earlyAccessLeads);
    expect(rows.some((r) => r.name === "Bad Email")).toBe(false);
  });

  it("rejects a cross-origin (CSRF) request with 403 and writes no row", async () => {
    const res = await post(
      { name: "Evil Origin", email: "evil-origin@example.com" },
      "https://malicious-site.example",
    );
    expect(res.status).toBe(403);

    const rows = await db
      .select()
      .from(earlyAccessLeads)
      .where(eq(earlyAccessLeads.email, "evil-origin@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("accepts a tripped honeypot with 201 but inserts no row", async () => {
    const res = await post({
      name: "Spammy McBot",
      email: "bot@example.com",
      website: "http://spam.example",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await db
      .select()
      .from(earlyAccessLeads)
      .where(eq(earlyAccessLeads.email, "bot@example.com"));
    expect(rows).toHaveLength(0);
  });
});
