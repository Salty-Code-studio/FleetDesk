import { notFound } from "next/navigation";
import { publicPolicy } from "@/lib/booking/public";
import type { PolicyType } from "@/lib/admin/policies";

export const dynamic = "force-dynamic";

const TITLES: Record<PolicyType, string> = {
  rental_terms: "Rental Terms",
  cancellation: "Cancellation & Refund Policy",
  privacy: "Privacy Policy",
};

export default async function PolicyPage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!["rental_terms", "cancellation", "privacy"].includes(type)) notFound();
  const policy = await publicPolicy(type as PolicyType);

  return (
    <div className="wrap policy-doc">
      <h1>{TITLES[type as PolicyType]}</h1>
      {!policy ? (
        <p className="note">This policy has not been published yet. Please contact us for details.</p>
      ) : (
        <>
          <p className="note">Version {policy.version}{policy.publishedAt ? ` · published ${new Date(policy.publishedAt).toLocaleDateString()}` : ""}</p>
          <pre>{policy.body}</pre>
        </>
      )}
      <p style={{ marginTop: "1.5rem" }}><a href="/book">← Back to booking</a></p>
    </div>
  );
}
