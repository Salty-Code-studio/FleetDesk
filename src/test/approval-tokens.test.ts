import { describe, it, expect } from "vitest";
import { issueApprovalToken, verifyApprovalToken, hashToken } from "@/lib/approval/tokens";

const RID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("approval tokens", () => {
  it("round-trips a valid token", () => {
    const t = issueApprovalToken(RID);
    expect(verifyApprovalToken(t)).toBe(RID);
  });
  it("rejects a tampered mac, a tampered id, and garbage", () => {
    const t = issueApprovalToken(RID);
    expect(verifyApprovalToken(t.slice(0, -2) + "aa")).toBeNull();
    expect(verifyApprovalToken("1f8fad5b-d9cb-469f-a165-70867728950e" + t.slice(36))).toBeNull();
    expect(verifyApprovalToken("nonsense")).toBeNull();
    expect(verifyApprovalToken("")).toBeNull();
    expect(verifyApprovalToken(RID + ".ab")).toBeNull();
  });
  it("hashes deterministically and never equals the token", () => {
    const t = issueApprovalToken(RID);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toBe(t);
  });
});
