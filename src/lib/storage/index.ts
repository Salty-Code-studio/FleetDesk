/**
 * Object storage facade (spec W4, shared infra). One import site for the app:
 *   import { putObject, getObject, getSignedUrl, deleteObject } from "@/lib/storage";
 * Driver chosen by env.STORAGE_DRIVER: 'local' (dev/test) or 'supabase' (prod,
 * private bucket + service-role key). Keys are validated against traversal on
 * every call, whichever driver is active. Media is PRIVATE by construction:
 * nothing here ever produces a public URL.
 */
import { env } from "@/env";
import { assertSafeKey, type StorageDriver } from "./shared";

export { assertSafeKey, contentTypeForKey, isObjectNotFoundError, type StorageDriver } from "./shared";

let driverPromise: Promise<StorageDriver> | null = null;

function getDriver(): Promise<StorageDriver> {
  driverPromise ??= env.STORAGE_DRIVER === "supabase"
    ? import("./supabase").then((m) => m.supabaseDriver())
    : import("./local").then((m) => m.localDriver());
  return driverPromise;
}

export async function putObject(key: string, data: Uint8Array, contentType: string): Promise<void> {
  assertSafeKey(key);
  return (await getDriver()).putObject(key, data, contentType);
}

export async function getObject(key: string): Promise<{ data: Uint8Array; contentType: string }> {
  assertSafeKey(key);
  return (await getDriver()).getObject(key);
}

export async function getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
  assertSafeKey(key);
  return (await getDriver()).getSignedUrl(key, ttlSeconds);
}

export async function deleteObject(key: string): Promise<void> {
  assertSafeKey(key);
  return (await getDriver()).deleteObject(key);
}
