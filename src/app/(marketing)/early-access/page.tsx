import type { Metadata } from "next";
import Reveal from "../reveal";
import EarlyAccessForm from "./early-access-form";
import "./early-access.css";

// Yabi early access. The funnel endpoint. Short, reassuring intro on the
// left, the lead-capture form on the right. Sand and Surf palette, one coral
// accent per view (the submit button), varied rhythm. No external assets.

export const metadata: Metadata = {
  title: "Request early access · Yabi",
  description:
    "Join Yabi early access. We onboard you personally, load your fleet, and lock your early-adopter price for life.",
};

export default function EarlyAccessPage() {
  return (
    <>
      <Reveal />

      {/* PAGE INTRO */}
      <section className="surface-sand">
        <div className="shell">
          <div className="page-intro" data-reveal>
            <span className="eyebrow eyebrow-plain">Early access</span>
            <h1 className="display-lg">Get on the list. Run it from one desk.</h1>
            <p className="lead">
              Early access is hands-on. We onboard you personally, load and brand
              your fleet, and lock your early-adopter price for life. Tell us a
              little about your operation and we will be in touch.
            </p>
          </div>
        </div>
      </section>

      {/* INTRO NOTES + FORM */}
      <section className="section-tight surface-panel">
        <div className="shell">
          <div className="ea-split split">
            <div className="ea-aside" data-reveal>
              <span className="eyebrow">What you get</span>
              <h2 className="display-md ea-aside-head">
                A real onboarding, not a free trial you fight alone.
              </h2>
              <ul className="note-list ea-notes">
                <li>
                  We import your cars, classes and prices so you never start
                  from a blank screen.
                </li>
                <li>
                  We brand your booking page and help you put the link where
                  your customers already are.
                </li>
                <li>
                  Your early-adopter price is locked for life. About 30% off,
                  monthly, no long contract.
                </li>
                <li>
                  Days, not months. Most operators are live the same week we
                  load the fleet.
                </li>
              </ul>
            </div>

            <div className="ea-form-col" data-reveal data-reveal-delay="1">
              <EarlyAccessForm />
              <p className="form-trust">
                Monthly, cancel anytime, export your data.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
