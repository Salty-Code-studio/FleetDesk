import { z } from "zod";

/**
 * Shared zod schemas — the single place request shapes are defined.
 * Validating here (at the trust boundary) is our primary input-injection control.
 */

// A reasonably strict password policy. Length is the dominant strength factor;
// we set a sane floor and an upper bound (argon2 hashes very long inputs slowly,
// which could be abused for DoS — cap it).
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(128, "Password must be at most 128 characters");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("A valid email is required")
  .max(254, "Email is too long");

export const credentialsSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
  })
  .strict(); // reject unknown keys (mass-assignment / parameter pollution defense)

export const loginSchema = z
  .object({
    email: emailSchema,
    // On login don't over-constrain; just require a non-empty bounded string.
    password: z.string().min(1, "Password is required").max(128),
  })
  .strict();

export const createNoteSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(200),
    body: z.string().max(10_000).default(""),
  })
  .strict();

export const updateNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(10_000).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.body !== undefined, {
    message: "Provide at least one field to update",
  });

// Route param: note id must be a UUID we generated. Rejecting bad ids early
// avoids passing attacker-controlled junk to the data layer.
export const noteIdParamSchema = z.object({
  id: z.string().uuid("Invalid note id"),
});
