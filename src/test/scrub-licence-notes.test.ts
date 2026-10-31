import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { auditLog } from "@/lib/db/schema";

/** The 0026 migration blanks licence numbers the old desk path wrote into
 *  pickup inspection notes and their audit rows. */
const file = readFileSync(path.resolve(__dirname, "../../drizzle/0026_scrub_licence_notes.sql"), "utf8");
const expr = /regexp_replace\("notes", ('[^']*'), ('[^']*'), 'g'\)/.exec(file)!;
const statements = file.split("--> statement-breakpoint");

let db: Awaited<ReturnType<typeof getDb>>;
beforeAll(async () => { await runMigrations(); db = await getDb(); });

async function scrub(note: string): Promise<string> {
  const q = `select regexp_replace($n$${note}$n$, ${expr[1]}, ${expr[2]}, 'g') as out`;
  const res = (await db.execute(sql.raw(q))) as unknown as { rows: { out: string }[] };
  return res.rows[0]!.out;
}

describe("0026 scrub licence notes", () => {
  it("found the expression in the migration", () => expect(expr).not.toBeNull());

  it("blanks the number and keeps the driver name", async () => {
    expect(await scrub("Driver: Maria van Dijk, licence NL-123456")).toBe("Driver: Maria van Dijk, licence on file");
  });

  it("blanks a number with a space in it", async () => {
    expect(await scrub("Driver: Jan, licence X99 88")).toBe("Driver: Jan, licence on file");
  });

  it("keeps other lines and text after the number", async () => {
    expect(await scrub("Late flight\nDriver: Jan, licence X99. Scratch rear bumper\nKeys in box"))
      .toBe("Late flight\nDriver: Jan, licence on file. Scratch rear bumper\nKeys in box");
  });

  it("handles a comma in the driver name", async () => {
    expect(await scrub("Driver: Smith, John, licence NL123")).toBe("Driver: Smith, John, licence on file");
  });

  it("leaves free text without a number alone", async () => {
    expect(await scrub("Driver: Jan, licence expires March, ask for passport")).toBe("Driver: Jan, licence expires March, ask for passport");
    expect(await scrub("Driver: Jan")).toBe("Driver: Jan");
  });

  it("scrubs audit_log before and after for inspections only, and re-runs safely", async () => {
    const [insp] = await db.insert(auditLog).values({
      actor: "system", action: "admin.inspection_updated", entity: "inspection",
      before: { notes: "" }, after: { notes: "Driver: Jan, licence NL998877", odometer: 5 },
    }).returning();
    const [other] = await db.insert(auditLog).values({
      actor: "system", action: "admin.booking_updated", entity: "booking",
      after: { notes: "Driver: Jan, licence NL998877" },
    }).returning();
    for (let run = 0; run < 2; run++) for (const s of statements) await db.execute(sql.raw(s));
    const [a] = await db.select().from(auditLog).where(eq(auditLog.id, insp!.id));
    expect(a!.after).toEqual({ notes: "Driver: Jan, licence on file", odometer: 5 });
    expect(a!.before).toEqual({ notes: "" });
    const [b] = await db.select().from(auditLog).where(eq(auditLog.id, other!.id));
    expect(b!.after).toEqual({ notes: "Driver: Jan, licence NL998877" });
  });
});
