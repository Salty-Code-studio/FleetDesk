import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { emailLog } from "@/lib/db/schema";
import { sendAndLog } from "@/lib/email/send";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => { db = await getDb(); await runMigrations(); });

describe("sendAndLog (no Resend key configured)", () => {
  it("skips delivery, records an email_log row, and never throws", async () => {
    const status = await sendAndLog({ to: "x@test.com", type: "login_code", subject: "Hi", html: "<p>hi</p>" });
    expect(status).toBe("skipped");
    const rows = await db.select().from(emailLog).where(eq(emailLog.to, "x@test.com"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[0]!.type).toBe("login_code");
  });
});
