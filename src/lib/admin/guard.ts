/**
 * Uniform admin route plumbing so every resource enforces the same controls.
 *
 *   read(req, fn)            — GET: requireAdmin, then fn. Safe method, no CSRF.
 *   mutate(req, action, fn)  — POST/PATCH/DELETE: requireAdmin (which enforces
 *                              CSRF on unsafe methods), run fn, then audit-log
 *                              `action` with whatever {before, after, entityId}
 *                              fn returns. The audit write never blocks success.
 */
import { requireAdmin, type AdminContext, type RequireAdminOptions } from "@/lib/auth/admin-auth";
import { audit } from "@/lib/audit";
import { translateDbError } from "@/lib/db/errors";

export async function read<T>(
  req: Request,
  fn: (ctx: AdminContext) => Promise<T>,
  opts?: RequireAdminOptions,
): Promise<T> {
  const ctx = await requireAdmin(req, opts);
  return fn(ctx);
}

export interface MutationOutcome<T> {
  result: T;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

export async function mutate<T>(
  req: Request,
  action: string,
  fn: (ctx: AdminContext) => Promise<MutationOutcome<T>>,
  opts?: RequireAdminOptions,
): Promise<T> {
  const ctx = await requireAdmin(req, opts);
  let outcome: MutationOutcome<T>;
  try {
    outcome = await fn(ctx);
  } catch (e) {
    // Turn a constraint violation (e.g. a unique-slug race) into a clean 4xx
    // instead of leaking a generic 500.
    const translated = translateDbError(e);
    if (translated) throw translated;
    throw e;
  }
  await audit({
    actor: ctx.admin.id,
    action,
    entity: outcome.entity,
    entityId: outcome.entityId,
    before: outcome.before,
    after: outcome.after,
    req,
  });
  return outcome.result;
}
