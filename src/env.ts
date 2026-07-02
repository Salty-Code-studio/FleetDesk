import { z } from "zod";

/**
 * Environment schema validation — runs at module load (boot) and FAILS CLOSED.
 *
 * Why this exists (defense-in-depth, fail-closed):
 *   A missing/weak secret is a security bug, not a runtime inconvenience. We
 *   validate ALL configuration at the trust boundary between the deployment
 *   platform and the app. If anything is missing, malformed, or too weak, the
 *   process refuses to start. This prevents shipping with a default/empty JWT
 *   secret — a classic instance of OWASP A02:2021 (Cryptographic Failures) and
 *   A05:2021 (Security Misconfiguration).
 *
 * Notes:
 *   - This module MUST NOT be imported into client components. It reads secrets.
 *     Next.js keeps it server-only as long as it's only used in route handlers,
 *     middleware, and server libs. We add a runtime guard below as a backstop.
 *   - We never log secret VALUES. Errors mention variable NAMES only.
 */

if (typeof window !== "undefined") {
  // Backstop against accidental client-bundle inclusion. Fail loudly.
  throw new Error("env.ts was imported in a browser context. This module is server-only.");
}

/** A secret must be long enough to resist brute force. 32 bytes ~ 43 base64 chars. */
const MIN_SECRET_LENGTH = 32;

/** Reject the obvious placeholder values shipped in .env.example. */
const looksLikePlaceholder = (value: string): boolean =>
  /change_me|placeholder|example|your[_-]?secret/i.test(value);

const secret = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .min(MIN_SECRET_LENGTH, `${name} must be at least ${MIN_SECRET_LENGTH} characters`)
    .refine((v) => !looksLikePlaceholder(v), {
      message: `${name} still contains a placeholder value — generate a real secret`,
    });

const positiveInt = (name: string) =>
  z.coerce
    .number({ invalid_type_error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .positive(`${name} must be positive`);

/** Comma-separated origins -> validated string[] of exact origins. */
const originList = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .url("CORS_ALLOWED_ORIGINS entries must be absolute URLs (scheme + host)")
          .refine((u) => {
            // An "origin" must not carry a path/query/fragment.
            try {
              const parsed = new URL(u);
              return parsed.origin === u.replace(/\/$/, "");
            } catch {
              return false;
            }
          }, "CORS_ALLOWED_ORIGINS entries must be bare origins (no path)"),
      )
      .min(1, "CORS_ALLOWED_ORIGINS must list at least one origin"),
  );

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    APP_ORIGIN: z.string().url("APP_ORIGIN must be an absolute URL"),
    CORS_ALLOWED_ORIGINS: originList,

    SESSION_SECRET: secret("SESSION_SECRET"),
    SESSION_TTL_SECONDS: positiveInt("SESSION_TTL_SECONDS").default(86_400),
    // Idle timeout: a session unused for this long dies even before the
    // absolute SESSION_TTL_SECONDS expiry (spec §4: idle + absolute timeout).
    SESSION_IDLE_TTL_SECONDS: positiveInt("SESSION_IDLE_TTL_SECONDS").default(1_800),

    // Postgres connection. postgres:// for Supabase/Neon/real Postgres,
    // pglite://memory or pglite://<dir> for the zero-install dev/test database.
    // For Supabase serverless runtime, use the TRANSACTION POOLER URL (:6543).
    DATABASE_URL: z
      .string({ required_error: "DATABASE_URL is required" })
      .min(1, "DATABASE_URL is required")
      .refine(
        (v) => /^(postgres(ql)?|pglite):\/\//.test(v),
        "DATABASE_URL must start with postgres:// or pglite://",
      ),

    // OPTIONAL direct/session connection used ONLY to run migrations (DDL).
    // Supabase recommends migrating over the DIRECT connection (:5432), not the
    // transaction pooler (:6543). When set, `db:migrate` uses this; the running
    // app still uses DATABASE_URL. Leave empty to migrate over DATABASE_URL.
    DATABASE_MIGRATION_URL: z
      .string()
      .optional()
      .default("")
      .refine(
        (v) => v === "" || /^postgres(ql)?:\/\//.test(v),
        "DATABASE_MIGRATION_URL must be a postgres:// URL or empty",
      ),

    // Stripe (payments). Prefer a RESTRICTED key (rk_) over a secret key (sk_).
    STRIPE_SECRET_KEY: z
      .string({ required_error: "STRIPE_SECRET_KEY is required" })
      .refine((v) => !looksLikePlaceholder(v), { message: "STRIPE_SECRET_KEY still contains a placeholder value" })
      .refine((v) => /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(v), { message: "STRIPE_SECRET_KEY must be an sk_/rk_ key" }),
    // Webhook signing secret for verifying inbound Stripe events.
    STRIPE_WEBHOOK_SECRET: z
      .string({ required_error: "STRIPE_WEBHOOK_SECRET is required" })
      .refine((v) => !looksLikePlaceholder(v), { message: "STRIPE_WEBHOOK_SECRET still contains a placeholder value" })
      .refine((v) => /^whsec_[A-Za-z0-9]+$/.test(v), { message: "STRIPE_WEBHOOK_SECRET must start with whsec_" }),

    // 32-byte base64 key for AES-256-GCM field encryption (license PII).
    // Generate with: openssl rand -base64 32
    DATA_ENCRYPTION_KEY: z
      .string({ required_error: "DATA_ENCRYPTION_KEY is required" })
      .refine((v) => !looksLikePlaceholder(v), {
        message: "DATA_ENCRYPTION_KEY still contains a placeholder value — generate a real key",
      })
      .transform((v, ctx) => {
        const buf = Buffer.from(v, "base64");
        if (buf.length !== 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "DATA_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32)",
          });
          return z.NEVER;
        }
        return buf;
      }),

    RATE_LIMIT_GLOBAL_MAX: positiveInt("RATE_LIMIT_GLOBAL_MAX").default(100),
    RATE_LIMIT_GLOBAL_WINDOW_SECONDS: positiveInt("RATE_LIMIT_GLOBAL_WINDOW_SECONDS").default(60),
    RATE_LIMIT_AUTH_MAX: positiveInt("RATE_LIMIT_AUTH_MAX").default(5),
    RATE_LIMIT_AUTH_WINDOW_SECONDS: positiveInt("RATE_LIMIT_AUTH_WINDOW_SECONDS").default(60),

    // Whether to trust client-supplied forwarding headers (X-Forwarded-For /
    // X-Real-IP) for the rate-limit client identifier. DEFAULT FALSE
    // (secure-by-default): these headers are trivially spoofable, so honoring
    // them unconditionally lets an attacker rotate the value per request and
    // bypass the brute-force limiter entirely. Set TRUE ONLY when this app sits
    // behind a reverse proxy / platform edge that OVERWRITES these headers.
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // Email (Resend) — OPTIONAL. With no key, transactional email is skipped
    // and logged; bookings and boot are never blocked by missing email config.
    RESEND_API_KEY: z
      .string()
      .refine((v) => v === "" || /^re_[A-Za-z0-9]+$/.test(v), { message: "RESEND_API_KEY must be a re_ key or empty" })
      .optional()
      .default(""),
    EMAIL_FROM: z.string().optional().default("FleetDesk <bookings@fleetdesk.app>"),

    // Local-dev ONLY: return the passwordless login OTP in the /api/auth/request
    // response so local testing works without an email provider. Default false
    // (fail-closed). The route ALSO requires non-production, so this can never
    // leak the OTP from a production deploy even if mis-set. NEVER set true
    // outside local development.
    AUTH_DEV_RETURN_CODE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    // Public product demo. When true, POST /api/admin/auth/demo issues a full
    // admin session for the seeded demo admin (demo@fleetdesk.app) with NO
    // password or MFA, so prospects can click straight into the ops dashboard.
    // DEFAULT FALSE (fail-closed): a real customer deployment MUST leave this
    // unset so the demo door 404s and admin access stays password + MFA only.
    // Pair with NEXT_PUBLIC_DEMO_MODE=true to show the "Enter the live demo"
    // button on the sign-in page (that public flag only controls the button).
    DEMO_MODE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    // Upstash Redis (rate-limit store) — OPTIONAL. When both are set, the rate
    // limiter coordinates across all serverless instances (spec §11). Falls back
    // to the in-memory per-instance limiter when unset.
    UPSTASH_REDIS_REST_URL: z.string().url().optional().or(z.literal("")).default(""),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional().default(""),

    // Shared secret for the scheduled maintenance cron (hold expiry). OPTIONAL;
    // the cron endpoint refuses to run without it.
    CRON_SECRET: z.string().optional().default(""),

    // Owner WhatsApp alerts (Meta WhatsApp Business Cloud API) — OPTIONAL. With
    // all three set, owner alerts also push to WhatsApp; otherwise that channel
    // is skipped and only email is used. The owner must provision a WhatsApp
    // Business number + permanent token.
    WHATSAPP_TOKEN: z.string().optional().default(""),
    WHATSAPP_PHONE_ID: z.string().optional().default(""),
    WHATSAPP_OWNER_TO: z.string().optional().default(""),
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Print variable NAMES + messages, never values. Then fail closed.
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    const banner = "Invalid environment configuration. The app will not start.\n";
    // eslint-disable-next-line no-console -- boot-time fatal; logger may not be ready.
    console.error(`\n${banner}${lines.join("\n")}\n`);
    throw new Error("Environment validation failed (see errors above).");
  }
  return parsed.data;
}

/** Validated, frozen environment. Import this everywhere instead of process.env. */
export const env: Readonly<Env> = Object.freeze(loadEnv());

export const isProd = env.NODE_ENV === "production";

// Boot warning: in production without a trusted IP source (TRUST_PROXY) AND
// without a shared Redis store, the rate limiter falls back to a best-effort
// request fingerprint a client can rotate (User-Agent etc.) to evade the per-IP
// tiers. Per-account lockout and per-scope caps (e.g. per-email) still hold, but
// the global IP-based DoS protection is weak. Fix: TRUST_PROXY=true behind a
// trusted edge and/or configure UPSTASH_*.
if (isProd && !env.TRUST_PROXY && !(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)) {
  // eslint-disable-next-line no-console -- boot-time operational warning.
  console.warn(
    "[fleetdesk] WARNING: rate limiter is keyed on a spoofable request fingerprint " +
      "(TRUST_PROXY=false and no Upstash Redis in production). Per-IP limits can be " +
      "evaded by rotating the User-Agent. Set TRUST_PROXY=true behind a trusted edge " +
      "and/or configure UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.",
  );
}
