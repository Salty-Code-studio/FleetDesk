-- Flow Desk phase 4 removed the old desk check-in path, which wrote
-- "Driver: <name>, licence <number>" in plain text into the pickup inspection
-- notes (PUT /inspection/pickup), and through mutate() into audit_log too.
-- Licences now live encrypted in licenses. Blank only the number: it must
-- contain a digit, so free text like "licence expires March" is left alone.
-- Rewriting audit_log is a deliberate exception to append-only: it removes
-- personal data the log should never have held. Safe to re-run.
UPDATE "inspections"
SET "notes" = regexp_replace("notes", '(Driver: ([^\n,]|,(?! licence ))*), licence [^\s,.;]*[0-9][^\s,.;]*( [^\s,.;]*[0-9][^\s,.;]*)*', '\1, licence on file', 'g')
WHERE "notes" ~ '(Driver: ([^\n,]|,(?! licence ))*), licence [^\s,.;]*[0-9][^\s,.;]*( [^\s,.;]*[0-9][^\s,.;]*)*';--> statement-breakpoint
UPDATE "audit_log"
SET "after" = jsonb_set("after", '{notes}', to_jsonb(regexp_replace("after"->>'notes', '(Driver: ([^\n,]|,(?! licence ))*), licence [^\s,.;]*[0-9][^\s,.;]*( [^\s,.;]*[0-9][^\s,.;]*)*', '\1, licence on file', 'g')))
WHERE "entity" = 'inspection' AND "after"->>'notes' ~ '(Driver: ([^\n,]|,(?! licence ))*), licence [^\s,.;]*[0-9][^\s,.;]*( [^\s,.;]*[0-9][^\s,.;]*)*';--> statement-breakpoint
UPDATE "audit_log"
SET "before" = jsonb_set("before", '{notes}', to_jsonb(regexp_replace("before"->>'notes', '(Driver: ([^\n,]|,(?! licence ))*), licence [^\s,.;]*[0-9][^\s,.;]*( [^\s,.;]*[0-9][^\s,.;]*)*', '\1, licence on file', 'g')))
WHERE "entity" = 'inspection' AND "before"->>'notes' ~ '(Driver: ([^\n,]|,(?! licence ))*), licence [^\s,.;]*[0-9][^\s,.;]*( [^\s,.;]*[0-9][^\s,.;]*)*';
