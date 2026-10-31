import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

/** The 0026 migration blanks licence numbers the old desk path wrote into
 *  notes. Run its exact expression over sample notes. */
const file = readFileSync(path.resolve(__dirname, "../../drizzle/0026_scrub_licence_notes.sql"), "utf8");
const expr = /regexp_replace\("notes", ('[^']*'), ('[^']*'), 'g'\)/.exec(file)!;

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

  it("keeps other lines intact", async () => {
    expect(await scrub("Late flight\nDriver: Jan, licence X99 88\nKeys in box"))
      .toBe("Late flight\nDriver: Jan, licence on file\nKeys in box");
  });

  it("leaves a driver line without a licence alone", async () => {
    expect(await scrub("Driver: Jan")).toBe("Driver: Jan");
  });
});
