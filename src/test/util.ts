/** Drizzle wraps driver errors ("Failed query: …") with the Postgres error in
 *  `cause`. Assert a rejection whose combined message matches `pattern`. */
export async function expectReject(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: unknown };
    const causeMsg = err.cause instanceof Error ? err.cause.message : String(err.cause ?? "");
    const text = `${err.message} ${causeMsg}`;
    if (pattern.test(text)) return;
    throw new Error(`Rejected, but message did not match ${pattern}:\n${text}`);
  }
  throw new Error(`Expected rejection matching ${pattern}, but the promise resolved`);
}
