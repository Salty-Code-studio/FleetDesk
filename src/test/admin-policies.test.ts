import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { publishPolicy, getLatestPolicy, policyOverview, getPolicyVersion, PolicyPublishSchema } from "@/lib/admin/policies";

beforeAll(async () => { await runMigrations(); });

describe("versioned policies", () => {
  it("publishes incrementing versions per type without mutating old ones", async () => {
    const v1 = await publishPolicy({ type: "rental_terms", body: "First terms." });
    expect(v1.version).toBe(1);
    const v2 = await publishPolicy({ type: "rental_terms", body: "Second terms." });
    expect(v2.version).toBe(2);

    const latest = await getLatestPolicy("rental_terms");
    expect(latest?.version).toBe(2);
    expect(latest?.body).toBe("Second terms.");

    // old version still retrievable for proof
    const old = await getPolicyVersion("rental_terms", 1);
    expect(old?.body).toBe("First terms.");
  });

  it("versions are independent per type", async () => {
    await publishPolicy({ type: "privacy", body: "Privacy v1." });
    const privacy = await getLatestPolicy("privacy");
    expect(privacy?.version).toBe(1); // not affected by rental_terms versions
  });

  it("overview reports latest + version count for all three types", async () => {
    const overview = await policyOverview();
    expect(overview.map((o) => o.type).sort()).toEqual(["cancellation", "privacy", "rental_terms"]);
    const terms = overview.find((o) => o.type === "rental_terms")!;
    expect(terms.versionCount).toBe(2);
    const cancellation = overview.find((o) => o.type === "cancellation")!;
    expect(cancellation.latest).toBeNull();
    expect(cancellation.versionCount).toBe(0);
  });

  it("requires a non-empty body", () => {
    expect(PolicyPublishSchema.safeParse({ type: "privacy", body: "" }).success).toBe(false);
  });

  it("assigns distinct versions to concurrent publishes (race-safe, no 500)", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => publishPolicy({ type: "cancellation", body: `concurrent ${i}` })),
    );
    const versions = results.map((r) => r.version).sort((a, b) => a - b);
    // 6 unique, contiguous versions — none collided into a thrown unique violation
    expect(new Set(versions).size).toBe(6);
    expect(versions[versions.length - 1]! - versions[0]!).toBe(5);
  });
});
