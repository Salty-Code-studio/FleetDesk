/**
 * Stripe SDK isolation. The rest of the app talks to Stripe ONLY through this
 * module, so the network surface is one file and the charge math / webhook
 * reducer stay pure and testable. Pinned API version for reproducibility.
 */
import Stripe from "stripe";
import { env } from "@/env";

let client: Stripe | null = null;

export function getStripe(): Stripe {
  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-05-27.dahlia", // matches the pinned SDK version
    typescript: true,
  });
  return client;
}
