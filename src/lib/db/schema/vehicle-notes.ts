import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { vehicles } from "./fleet";
import { adminUsers } from "./admin";

/**
 * Per-car operational notes (complaints, future maintenance). Open notes
 * (resolvedAt IS NULL) surface as count badges on the fleet list and the
 * planning board; a note can be escalated to an availability block in one tap.
 * Lives in its own file (not fleet.ts): fleet.ts importing adminUsers would
 * close the module cycle fleet -> admin -> licenses -> bookings -> fleet.
 */
export const vehicleNotes = pgTable("vehicle_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  vehicleId: uuid("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdBy: uuid("created_by").references(() => adminUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("vehicle_notes_vehicle_idx").on(t.vehicleId)]);
