/**
 * Local-disk storage driver (dev/test). Files live under LOCAL_STORAGE_DIR
 * (default .dev-storage/). "Signed URLs" are HMAC-signed links to the dev-only
 * route /api/dev/storage/[...key], mirroring how the Supabase driver returns
 * short-lived signed URLs in production. The HMAC key is SESSION_SECRET, which
 * is already required to be strong at boot.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/env";
import { contentTypeForKey, type StorageDriver } from "./shared";

function baseDir(): string {
  return path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);
}

/** Resolve a key inside the storage dir; belt-and-braces escape check. */
function filePath(key: string): string {
  const fp = path.resolve(baseDir(), key);
  if (!fp.startsWith(baseDir() + path.sep)) throw new Error("Storage key escapes the storage directory");
  return fp;
}

export function signLocalUrl(key: string, expEpochSeconds: number): string {
  return createHmac("sha256", env.SESSION_SECRET).update(`${key}:${expEpochSeconds}`).digest("hex");
}

export function verifyLocalSignature(key: string, expEpochSeconds: number, sig: string): boolean {
  if (!Number.isInteger(expEpochSeconds) || expEpochSeconds * 1000 < Date.now()) return false;
  const expected = Buffer.from(signLocalUrl(key, expEpochSeconds));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function localDriver(): StorageDriver {
  return {
    async putObject(key, data) {
      const fp = filePath(key);
      await mkdir(path.dirname(fp), { recursive: true });
      await writeFile(fp, data);
    },
    async getObject(key) {
      const data = await readFile(filePath(key));
      return { data: new Uint8Array(data), contentType: contentTypeForKey(key) };
    },
    async getSignedUrl(key, ttlSeconds) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return `${env.APP_ORIGIN}/api/dev/storage/${key}?exp=${exp}&sig=${signLocalUrl(key, exp)}`;
    },
    async deleteObject(key) {
      await rm(filePath(key), { force: true });
    },
  };
}
