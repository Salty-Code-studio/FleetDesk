/** Apply pending migrations, then close the pool so the process exits cleanly
 *  (postgres-js keeps idle sockets open by default and would hang the script). */
import { runMigrations } from "../src/lib/db/migrate";
import { closeDb } from "../src/lib/db/client";

runMigrations()
  .then(async () => {
    await closeDb();
    console.log("migrations applied");
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
