# Final fixes report, flow-desk phase 1

Single commit on feat/flow-desk. Gates: `npx vitest run src/test/today-queue.test.ts` (17 passed), `npm run typecheck` clean, `npm run lint` (warnings only, none new), `npm test` (107 files, 624 tests passed). No `next build` run.

1. Done-but-unpaid: src/lib/admin/today.ts, buildToday override after classify (unpaid + picked_up/completed + done becomes done:false, action "Take payment", href null); module doc comment gains the "never closes while money is owed" sentence. Tests added in src/test/today-queue.test.ts after the "return that is also unpaid" test.
2. Unpaid note: src/app/admin/(shell)/page.tsx, row sub-text renders `, ${it.note}` verbatim; ", overdue" kept.
3. Staff dead-end: src/app/api/admin/today/route.ts returns viewerRole from ctx.admin.role. page.tsx types the board as TodayBoard & { viewerRole }, staff hero button is the first open item with an href, customer name is a span, no-href rows show span.td-row__owner. today.css gains .td-row__owner and `span.td-row__who { cursor: default }`. No loader test change; type-check is the gate.
4. Failed first load: page.tsx adds `failed` state (set in catch, cleared on success); skeleton only while loading; if no board and failed, EmptyState "Today did not load" with a "Try again" button.

Not done: no browser eyeballing. A refresh failure after a successful load keeps the stale board (only a first-load failure shows the empty state).
