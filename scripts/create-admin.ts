/**
 * Bootstrap an admin (owner) account. There is deliberately NO public
 * registration endpoint; this script is the only way accounts are created.
 *
 *   npm run admin:create -- owner@fleetdesk.app
 *
 * Password comes from TEX_ADMIN_PASSWORD, or a strong one is generated and
 * printed ONCE. MFA enrollment is forced at first login by the admin shell.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { runMigrations } from "../src/lib/db/migrate";
import { getDb, closeDb } from "../src/lib/db/client";
import { adminUsers } from "../src/lib/db/schema";
import { hashPassword } from "../src/lib/auth/password";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Usage: npm run admin:create -- owner@fleetdesk.app");
    process.exit(1);
  }

  await runMigrations();
  const db = await getDb();

  const [existing] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email));
  if (existing) {
    console.error(`Refusing: an admin with email ${email} already exists.`);
    process.exit(1);
  }

  const provided = process.env.TEX_ADMIN_PASSWORD;
  const password = provided ?? randomBytes(18).toString("base64url");

  await db.insert(adminUsers).values({
    email,
    passwordHash: await hashPassword(password),
    role: "owner",
  });

  console.log(`Admin created: ${email} (role: owner)`);
  if (!provided) {
    console.log(`Generated password (shown once, store it in a password manager):\n\n  ${password}\n`);
  }
  console.log("MFA enrollment is required at first sign-in.");
}

main()
  .then(async () => { await closeDb(); process.exit(0); })
  .catch(async (e) => { console.error(e); await closeDb().catch(() => undefined); process.exit(1); });
