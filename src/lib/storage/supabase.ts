/**
 * Supabase Storage driver (production). Talks to a PRIVATE bucket
 * (STORAGE_BUCKET, default fleet-docs) with the SERVICE-ROLE key, exactly what
 * the driver_licenses.documentRef comment anticipated: private object storage,
 * opened only via short-lived signed URLs or same-origin admin streaming.
 * One-time prod setup (documented here, not automated): create the bucket in
 * the Supabase dashboard with "Public bucket" OFF.
 */
import { createClient } from "@supabase/supabase-js";
import { env } from "@/env";
import { contentTypeForKey, type StorageDriver } from "./shared";

export function supabaseDriver(): StorageDriver {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = () => client.storage.from(env.STORAGE_BUCKET);

  return {
    async putObject(key, data, contentType) {
      const { error } = await bucket().upload(key, data, { contentType, upsert: true });
      if (error) throw new Error(`storage upload failed for ${key}: ${error.message}`);
    },
    async getObject(key) {
      const { data, error } = await bucket().download(key);
      if (error || !data) throw new Error(`storage download failed for ${key}: ${error?.message ?? "no data"}`);
      return { data: new Uint8Array(await data.arrayBuffer()), contentType: data.type || contentTypeForKey(key) };
    },
    async getSignedUrl(key, ttlSeconds) {
      const { data, error } = await bucket().createSignedUrl(key, ttlSeconds);
      if (error || !data?.signedUrl) throw new Error(`storage sign failed for ${key}: ${error?.message ?? "no url"}`);
      return data.signedUrl;
    },
    async deleteObject(key) {
      const { error } = await bucket().remove([key]);
      if (error) throw new Error(`storage delete failed for ${key}: ${error.message}`);
    },
  };
}
