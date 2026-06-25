"use client";

import { useId, useRef, useState } from "react";
import { Select } from "@/components/ui";

// Early access lead capture. Client component. Posts JSON to /api/early-access
// (same origin). Inline validation, disabled while submitting, accessible error
// messaging tied to each input. On success the whole form is swapped for a
// confirmation block. Honeypot field `website` stays empty for real people.

type FieldName = "name" | "email" | "company" | "country" | "fleetSize" | "message";

type FormState = {
  name: string;
  email: string;
  company: string;
  country: string;
  fleetSize: "" | "1-5" | "6-10" | "11-25" | "26-50" | "50+";
  message: string;
  website: string; // honeypot
};

type FieldErrors = Partial<Record<FieldName, string>>;

const FLEET_PLACEHOLDER = "Select a range";
const FLEET_OPTIONS: Array<{ value: FormState["fleetSize"]; label: string }> = [
  { value: "1-5", label: "1 to 5 cars" },
  { value: "6-10", label: "6 to 10 cars" },
  { value: "11-25", label: "11 to 25 cars" },
  { value: "26-50", label: "26 to 50 cars" },
  { value: "50+", label: "More than 50 cars" },
];

const EMPTY: FormState = {
  name: "",
  email: "",
  company: "",
  country: "",
  fleetSize: "",
  message: "",
  website: "",
};

// Lightweight client-side checks that mirror the server zod rules. The server
// is the source of truth, this is just for fast, friendly inline feedback.
function validate(values: FormState): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.name.trim();
  const email = values.email.trim();

  if (name.length === 0) {
    errors.name = "Please tell us your name.";
  } else if (name.length > 120) {
    errors.name = "That name is a little too long.";
  }

  if (email.length === 0) {
    errors.email = "We need a work email to reach you.";
  } else if (email.length > 200) {
    errors.email = "That email is a little too long.";
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "That does not look like a valid email.";
  }

  if (values.company.trim().length > 160) {
    errors.company = "That business name is a little too long.";
  }
  if (values.country.trim().length > 80) {
    errors.country = "That country name is a little too long.";
  }
  if (values.message.trim().length > 2000) {
    errors.message = "Please keep your note under 2000 characters.";
  }

  return errors;
}

export default function EarlyAccessForm() {
  const baseId = useId();
  const fieldId = (name: string) => `${baseId}-${name}`;
  const errorId = (name: string) => `${baseId}-${name}-error`;
  const alertRef = useRef<HTMLDivElement>(null);

  const [values, setValues] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Clear a field error as soon as the person starts fixing it.
    if (key !== "website" && errors[key as FieldName]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key as FieldName];
        return next;
      });
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const nextErrors = validate(values);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setFormError(null);
      // Move focus to the first field with an error for keyboard users.
      const order: FieldName[] = ["name", "email", "company", "country", "message"];
      const first = order.find((f) => nextErrors[f]);
      if (first) {
        document.getElementById(fieldId(first))?.focus();
      }
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const res = await fetch("/api/early-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name.trim(),
          email: values.email.trim(),
          company: values.company.trim(),
          country: values.country.trim(),
          fleetSize: values.fleetSize,
          message: values.message.trim(),
          website: values.website,
        }),
      });

      if (res.status === 201) {
        setDone(true);
        return;
      }

      if (res.status === 422) {
        // Map field-level server errors back onto the inputs where we can.
        const mapped: FieldErrors = {};
        try {
          const payload = (await res.json()) as {
            error?: { details?: Array<{ path?: string; message?: string }> };
          };
          const details = payload.error?.details;
          if (Array.isArray(details)) {
            const allowed: FieldName[] = [
              "name",
              "email",
              "company",
              "country",
              "fleetSize",
              "message",
            ];
            for (const item of details) {
              const path = item?.path as FieldName | undefined;
              if (path && allowed.includes(path) && item.message) {
                mapped[path] = item.message;
              }
            }
          }
        } catch {
          // Body was not JSON we could read. Fall through to the generic note.
        }
        if (Object.keys(mapped).length > 0) {
          setErrors(mapped);
          setFormError("Please check the highlighted fields and try again.");
        } else {
          setFormError("Some details need a second look. Please review and try again.");
        }
        alertRef.current?.focus();
        return;
      }

      if (res.status === 429) {
        setFormError(
          "That is a lot of requests in a short time. Please wait a minute and try again.",
        );
        alertRef.current?.focus();
        return;
      }

      setFormError(
        "Something went wrong on our side. Please try again in a moment.",
      );
      alertRef.current?.focus();
    } catch {
      setFormError(
        "We could not reach the server. Check your connection and try again.",
      );
      alertRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="form-card">
        <div className="form-success" role="status">
          <div className="tick" aria-hidden="true">
            &#10003;
          </div>
          <h3>You&apos;re on the list.</h3>
          <p>We&apos;ll be in touch within 2 business days.</p>
        </div>
      </div>
    );
  }

  return (
    <form className="form-card" onSubmit={handleSubmit} noValidate>
      {formError && (
        <div
          className="form-alert"
          role="alert"
          tabIndex={-1}
          ref={alertRef}
        >
          {formError}
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor={fieldId("name")}>
          Name <span className="req">*</span>
        </label>
        <input
          id={fieldId("name")}
          name="name"
          type="text"
          autoComplete="name"
          className={`input${errors.name ? " has-error" : ""}`}
          value={values.name}
          onChange={(e) => update("name", e.target.value)}
          required
          maxLength={120}
          disabled={submitting}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? errorId("name") : undefined}
        />
        {errors.name && (
          <span className="field-error" id={errorId("name")}>
            {errors.name}
          </span>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor={fieldId("email")}>
          Work email <span className="req">*</span>
        </label>
        <input
          id={fieldId("email")}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          className={`input${errors.email ? " has-error" : ""}`}
          value={values.email}
          onChange={(e) => update("email", e.target.value)}
          required
          maxLength={200}
          disabled={submitting}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? errorId("email") : undefined}
        />
        {errors.email && (
          <span className="field-error" id={errorId("email")}>
            {errors.email}
          </span>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor={fieldId("company")}>
          Rental business name
        </label>
        <input
          id={fieldId("company")}
          name="company"
          type="text"
          autoComplete="organization"
          className={`input${errors.company ? " has-error" : ""}`}
          value={values.company}
          onChange={(e) => update("company", e.target.value)}
          maxLength={160}
          disabled={submitting}
          aria-invalid={errors.company ? true : undefined}
          aria-describedby={errors.company ? errorId("company") : undefined}
        />
        {errors.company && (
          <span className="field-error" id={errorId("company")}>
            {errors.company}
          </span>
        )}
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={fieldId("country")}>
            Country
          </label>
          <input
            id={fieldId("country")}
            name="country"
            type="text"
            autoComplete="country-name"
            className={`input${errors.country ? " has-error" : ""}`}
            value={values.country}
            onChange={(e) => update("country", e.target.value)}
            maxLength={80}
            disabled={submitting}
            aria-invalid={errors.country ? true : undefined}
            aria-describedby={errors.country ? errorId("country") : undefined}
          />
          {errors.country && (
            <span className="field-error" id={errorId("country")}>
              {errors.country}
            </span>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={fieldId("fleetSize")}>
            Fleet size
          </label>
          <Select
            id={fieldId("fleetSize")}
            name="fleetSize"
            value={values.fleetSize}
            onChange={(v) => update("fleetSize", v as FormState["fleetSize"])}
            options={FLEET_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.label,
            }))}
            placeholder={FLEET_PLACEHOLDER}
            ariaLabel="Fleet size"
            disabled={submitting}
          />
          {errors.fleetSize && (
            <span className="field-error" id={errorId("fleetSize")}>
              {errors.fleetSize}
            </span>
          )}
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={fieldId("message")}>
          Anything we should know? <span className="ea-optional">Optional</span>
        </label>
        <textarea
          id={fieldId("message")}
          name="message"
          className={`textarea${errors.message ? " has-error" : ""}`}
          value={values.message}
          onChange={(e) => update("message", e.target.value)}
          maxLength={2000}
          rows={4}
          disabled={submitting}
          placeholder="How you run things today, what you want to fix first."
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={errors.message ? errorId("message") : undefined}
        />
        {errors.message && (
          <span className="field-error" id={errorId("message")}>
            {errors.message}
          </span>
        )}
      </div>

      {/* Honeypot: hidden from people, tempting to bots. Real users leave it
          empty. Kept out of the tab order and the accessibility tree. */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor={fieldId("website")}>
          Website (leave this field empty)
        </label>
        <input
          id={fieldId("website")}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={(e) => update("website", e.target.value)}
        />
      </div>

      <button
        className="btn btn-primary btn-block btn-lg"
        type="submit"
        disabled={submitting}
      >
        {submitting ? "Sending..." : "Request early access"}
      </button>
    </form>
  );
}
