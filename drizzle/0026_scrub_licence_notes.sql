-- Flow Desk phase 4 removed the old desk check-in path that wrote
-- "Driver: <name>, licence <number>" in plain text. Licences now live
-- encrypted in licenses. Blank the number in any notes written before.
UPDATE "inspections"
SET "notes" = regexp_replace("notes", '(Driver: [^,\n]*), licence [^\n]*', '\1, licence on file', 'g')
WHERE "notes" ~ 'Driver: [^,\n]*, licence ';--> statement-breakpoint
UPDATE "bookings"
SET "notes" = regexp_replace("notes", '(Driver: [^,\n]*), licence [^\n]*', '\1, licence on file', 'g')
WHERE "notes" ~ 'Driver: [^,\n]*, licence ';
