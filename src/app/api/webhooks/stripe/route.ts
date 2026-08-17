import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { env, isDeskMode } from "@/env";
import { logger } from "@/lib/logger";
import { getStripe } from "@/lib/payments/stripe-client";
import { processStripeEvent } from "@/lib/payments/webhook";
import { notifyBookingConfirmed } from "@/lib/email/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/stripe — verify the signature on the RAW body, then
 * idempotently reduce the event. NOT wrapped in withRoute: we must read the
 * exact raw bytes Stripe signed, and we never want CORS/other headers to alter
 * the body. A bad signature is a 400; anything else is acked 200 so Stripe
 * stops retrying a genuine-but-unhandled event.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // This route is not wrapped in withRoute (see comment above), so match its
  // existing direct-NextResponse error style rather than throwing Errors.*.
  if (isDeskMode) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn("stripe_webhook_bad_signature", { error: (err as Error).message });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const result = await processStripeEvent(event);
    if (result.bookingConfirmed && result.bookingId) {
      await notifyBookingConfirmed(result.bookingId); // customer + admin alerts, best-effort
    }
    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    // Return 500 so Stripe RETRIES (the event id dedupe makes retries safe).
    logger.error("stripe_webhook_processing_failed", { eventId: event.id, error: (err as Error).message });
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
