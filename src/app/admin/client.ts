/** Client-side helpers for the admin UI (CSRF header + typed JSON fetch). */

export function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?csrf=([^;]+)/);
  return m?.[1] ?? "";
}

export interface ApiError { status: number; message: string; retryAfter?: string | null }

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = getCsrfToken();
  }
  const res = await fetch(path, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw {
      status: res.status,
      message: data?.error?.message ?? "Something went wrong. Please try again.",
      retryAfter: res.headers.get("Retry-After"),
    } satisfies ApiError;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const apiGet = <T>(path: string) => request<T>("GET", path);
export const api = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
export const apiPatch = <T>(path: string, body?: unknown) => request<T>("PATCH", path, body);
export const apiDelete = <T>(path: string) => request<T>("DELETE", path);
