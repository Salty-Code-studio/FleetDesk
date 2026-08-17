/**
 * One-time per deployment: points the bot's webhook at THIS deployment with
 * our secret. Run AFTER setting TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET
 * (+ APP_ORIGIN) in the environment: npm run telegram:setup
 */
import { env } from "../src/env";

async function main(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.");
    process.exit(1);
  }
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const me = await (await fetch(`${base}/getMe`)).json();
  console.log("Bot:", JSON.stringify(me.result ?? me));
  if (!me.ok) {
    console.error("getMe failed:", me.description ?? "unknown error");
    process.exit(1);
  }
  const hook = await (await fetch(`${base}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${env.APP_ORIGIN}/api/webhooks/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    }),
  })).json();
  console.log("setWebhook:", JSON.stringify(hook));
  if (!hook.ok) {
    console.error("setWebhook failed:", hook.description ?? "unknown error");
    process.exit(1);
  }
}

void main();
