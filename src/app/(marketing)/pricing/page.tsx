import type { Metadata } from "next";
import Link from "next/link";
import Reveal from "../reveal";
import "./pricing.css";

// Yabi pricing. Sand and Surf palette, one coral accent per view (the Pro
// tier and its badge). Honest roadmap framing: Stripe payments, widget coming.
// No external assets. No em-dashes in copy.

export const metadata: Metadata = {
  title: "Pricing · Yabi",
  description:
    "Starter, Pro and Business plans for small car rental fleets. Setup is one-time and early adopters lock about 30 percent off for life.",
};

export default function PricingPage() {
  return (
    <>
      <Reveal />

      {/* PAGE INTRO */}
      <section className="surface-sand">
        <div className="shell">
          <div className="page-intro" data-reveal>
            <span className="eyebrow eyebrow-plain">Pricing</span>
            <h1 className="display-xl">Plans that grow with the fleet.</h1>
            <p className="lead">
              Start where you are today. Move up when you add cars. Every plan
              includes online booking, the never double-books guarantee, and one
              ops desk to run it from.
            </p>
          </div>
        </div>
      </section>

      {/* PRICE CARDS */}
      <section className="section-tight surface-sand">
        <div className="shell">
          <div className="price-grid" data-reveal>
            {/* Starter */}
            <div className="price-card">
              <span className="price-name">Starter</span>
              <p className="price-tba">Early-access pricing</p>
              <p className="price-cap">Up to 10 cars.</p>
              <ul className="price-feats">
                <li>Online booking, 24/7</li>
                <li>Live fleet calendar</li>
                <li>Never double-books guarantee</li>
                <li>Instant, server-computed quotes</li>
                <li>Customer records and license capture</li>
              </ul>
              <Link className="btn btn-ghost btn-block" href="/early-access">
                Request access
              </Link>
            </div>

            {/* Pro (featured, the one coral accent) */}
            <div className="price-card featured">
              <span className="price-badge">Most operators start here</span>
              <span className="price-name">Pro</span>
              <p className="price-tba">Early-access pricing</p>
              <p className="price-cap">Up to 40 cars.</p>
              <ul className="price-feats">
                <li>Everything in Starter</li>
                <li>Maintenance windows and blackouts</li>
                <li>Reports that mean something</li>
                <li>Email and status notifications</li>
                <li>Multi-user access for your team</li>
              </ul>
              <Link className="btn btn-primary btn-block" href="/early-access">
                Request access
              </Link>
            </div>

            {/* Business */}
            <div className="price-card">
              <span className="price-name">Business</span>
              <p className="price-tba">Early-access pricing</p>
              <p className="price-cap">Unlimited cars.</p>
              <ul className="price-feats">
                <li>Everything in Pro</li>
                <li>Multi-location fleets</li>
                <li>Custom domain for your booking page</li>
                <li>Priority support</li>
                <li>Onboarding help when you grow</li>
              </ul>
              <Link className="btn btn-ghost btn-block" href="/early-access">
                Request access
              </Link>
            </div>
          </div>

          <div className="price-note" data-reveal>
            <p>
              <strong>Setup &euro;500 to 750</strong> one-time. We load and brand
              your fleet so you do not start from a blank screen.
            </p>
            <p>
              <strong>Early adopters lock about 30% off, for life.</strong> Join
              early access and your price never goes up.
            </p>
          </div>
        </div>
      </section>

      {/* WHAT IS INCLUDED / VALUE BAND */}
      <section className="section surface-panel">
        <div className="shell">
          <div className="split">
            <div data-reveal>
              <span className="eyebrow">In every plan</span>
              <h2 className="display-lg">
                The core never sits behind a higher tier.
              </h2>
              <p className="muted" style={{ marginTop: "1rem", maxWidth: "44ch" }}>
                We do not gate the parts that keep your fleet honest. Booking,
                the conflict guarantee, quotes and license capture ship on
                Starter and stay with you all the way up.
              </p>
            </div>
            <ul className="note-list" data-reveal data-reveal-delay="1">
              <li>
                Online booking your customers reach in any browser, no app to
                download.
              </li>
              <li>
                A database-level guarantee that two bookings can never hold the
                same car on overlapping dates.
              </li>
              <li>
                Server-computed quotes with insurance tiers and add-ons, so the
                price is always right.
              </li>
              <li>
                Encrypted driver-license capture filed with each booking, plus
                hardened security headers and audit logs.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* HONEST ROADMAP FRAMING */}
      <section className="section surface-sand">
        <div className="shell">
          <div className="section-head" data-reveal>
            <span className="eyebrow">Straight about what ships</span>
            <h2 className="display-lg">Here today. And honest about the rest.</h2>
            <p>
              We would rather under-promise. Two things worth being clear about
              before you commit.
            </p>
          </div>
          <div className="roadmap-grid" data-reveal data-reveal-delay="1">
            <div className="roadmap-card">
              <span className="roadmap-flag live">Live</span>
              <h3 className="display-md">Card payments through Stripe</h3>
              <p>
                Customers pay online when they book. Payments run through Stripe,
                so the money side is handled by a name your bank already trusts.
              </p>
            </div>
            <div className="roadmap-card">
              <span className="roadmap-flag soon">Coming</span>
              <h3 className="display-md">An embeddable booking widget</h3>
              <p>
                Today you link to your Yabi booking page or send the link.
                A drop-in widget for your own site is on the roadmap. We will not
                claim it ships before it does.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FULL FAQ */}
      <section className="section surface-panel" id="faq">
        <div className="shell">
          <div className="section-head" data-reveal>
            <span className="eyebrow">Questions</span>
            <h2 className="display-lg">The full set of answers.</h2>
          </div>
          <div className="faq" data-reveal data-reveal-delay="1">
            <div className="faq-item">
              <details>
                <summary>Do my customers need an app?</summary>
                <p className="faq-a">
                  No. They book in the browser. Nothing to download, on any
                  phone or laptop.
                </p>
              </details>
            </div>
            <div className="faq-item">
              <details>
                <summary>Can I keep my own website?</summary>
                <p className="faq-a">
                  Yes. Link to your Yabi booking page today, or send the
                  link to a customer directly. An embeddable widget for your own
                  site is coming.
                </p>
              </details>
            </div>
            <div className="faq-item">
              <details>
                <summary>What about payments?</summary>
                <p className="faq-a">
                  Card payments run through Stripe. Customers pay when they book
                  and you wake up to confirmed reservations.
                </p>
              </details>
            </div>
            <div className="faq-item">
              <details>
                <summary>Is my data safe?</summary>
                <p className="faq-a">
                  Driver licenses are encrypted, security headers are hardened,
                  and every action is audit-logged. Safety comes before
                  features here.
                </p>
              </details>
            </div>
            <div className="faq-item">
              <details>
                <summary>How fast can I launch?</summary>
                <p className="faq-a">
                  Days, not months. We load your fleet during setup, so you go
                  live with your real cars, classes and prices in place.
                </p>
              </details>
            </div>
            <div className="faq-item">
              <details>
                <summary>Can I cancel?</summary>
                <p className="faq-a">
                  Monthly billing, cancel anytime, and you can export your data
                  whenever you want. No lock-in, no hard feelings.
                </p>
              </details>
            </div>
          </div>
        </div>
      </section>

      {/* FINAL CTA BAND */}
      <section className="section surface-teal cta-band">
        <div className="shell" data-reveal>
          <h2>Lock your early-adopter price.</h2>
          <p>
            Join early access. We onboard you personally, load your fleet, and
            hold about 30% off for as long as you stay.
          </p>
          <div className="cta-actions">
            <Link className="btn btn-primary btn-lg" href="/early-access">
              Request early access
            </Link>
            <Link className="btn btn-ghost-on-teal btn-lg" href="/#features">
              See the features
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
