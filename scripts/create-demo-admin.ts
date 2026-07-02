/**
 * Provision the DEMO admin (idempotent).
 *
 *   npm run demo:admin
 *
 * Creates (or repairs) the single seeded demo admin with mfaEnabled=true so the
 * public demo door POST /api/admin/auth/demo can mint a session for it. This
 * only matters when the running app has DEMO_MODE=true; on a real customer
 * deployment the demo door is disabled regardless of whether this ran.
 */
import { runMigrations } from "../src/lib/db/migrate";
import { getDb, closeDb } from "../src/lib/db/client";
import { provisionDemoAdmin, DEMO_ADMIN_EMAIL } from "../src/lib/auth/demo";

async function main() {
  await runMigrations();
  const db = await getDb();
  const admin = await provisionDemoAdmin(db);
  console.log(`Demo admin ready: ${DEMO_ADMIN_EMAIL} (role: ${admin.role}, mfaEnabled: ${admin.mfaEnabled}).`);
  console.log("Prospects enter via the 'Enter the live demo' button on /admin/login (requires DEMO_MODE=true).");
}

main()
  .then(async () => { await closeDb(); process.exit(0); })
  .catch(async (e) => { console.error(e); await closeDb().catch(() => undefined); process.exit(1); });
