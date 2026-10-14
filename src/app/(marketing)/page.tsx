import Link from "next/link";
import Reveal from "./reveal";

// Yabi home / funnel. Single narrative scroll. Sand and Surf palette,
// one coral accent per view, varied section rhythm. No external assets.

function ProductFrame({ title }: { title: string }) {
  return (
    <div className="product-frame">
      <div className="pf-bar">
        <span className="pf-dot" />
        <span className="pf-dot" />
        <span className="pf-dot" />
        <span className="pf-title">{title}</span>
      </div>
      <div className="pf-body">
        <div className="pf-row is-active">
          <div className="pf-car">
            <span className="pf-thumb" aria-hidden="true" />
            <span>
              <span className="pf-car-name">Jeep Wrangler</span>
              <br />
              <span className="pf-car-meta">SUV · Plate A-4821</span>
            </span>
          </div>
          <span className="pf-tag hot">Booked</span>
        </div>
        <div className="pf-row">
          <div className="pf-car">
            <span className="pf-thumb" aria-hidden="true" />
            <span>
              <span className="pf-car-name">Hyundai i10</span>
              <br />
              <span className="pf-car-meta">Economy · Plate B-1190</span>
            </span>
          </div>
          <span className="pf-tag ok">Available</span>
        </div>
        <div className="pf-row">
          <div className="pf-car">
            <span className="pf-thumb sand" aria-hidden="true" />
            <span>
              <span className="pf-car-name">Kia Picanto</span>
              <br />
              <span className="pf-car-meta">Economy · Plate B-2207</span>
            </span>
          </div>
          <span className="pf-tag muted">Service</span>
        </div>
        <div className="pf-strip" aria-hidden="true">
          <span className="pf-cell book" />
          <span className="pf-cell book" />
          <span className="pf-cell book" />
          <span className="pf-cell book" />
          <span className="pf-cell" />
          <span className="pf-cell maint" />
          <span className="pf-cell" />
        </div>
        <div className="pf-stats">
          <div className="pf-stat">
            <div className="n">82%</div>
            <div className="k">Utilization</div>
          </div>
          <div className="pf-stat">
            <div className="n">14</div>
            <div className="k">Booked today</div>
          </div>
          <div className="pf-stat">
            <div className="n">0</div>
            <div className="k">Conflicts</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <Reveal />

      {/* 1. HERO */}
      <section className="hero surface-sand">
        <div className="shell hero-grid">
          <div className="hero-copy" data-reveal>
            <span className="eyebrow">Booking + ops for car rental fleets</span>
            <h1 className="display-xl">Run your fleet from one desk.</h1>
            <p className="lead">
              Yabi takes online bookings, blocks double-bookings at the
              database, and keeps every car, reservation and quote in one place.
              Clean code, warm coast.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary btn-lg" href="/early-access">
                Request early access
              </Link>
              <Link className="btn btn-ghost btn-lg" href="/book">
                See it live
              </Link>
            </div>
            <p className="hero-note">
              Built from a working island rental operation.
            </p>
          </div>
          <div className="hero-visual" data-reveal data-reveal-delay="1">
            <ProductFrame title="Yabi · Planning" />
          </div>
        </div>
      </section>

      {/* 2. TRUST STRIP */}
      <section className="surface-panel">
        <div className="shell">
          <div className="trust" data-reveal>
            <p className="trust-line">
              Built from a real island rental operation, not a slide deck.
            </p>
            <ul className="chips">
              <li className="chip chip-coral">No double-bookings</li>
              <li className="chip">Online booking</li>
              <li className="chip">One ops desk</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 3. PROBLEM -> SOLUTION */}
      <section className="section surface-sand">
        <div className="shell">
          <div className="section-head" data-reveal>
            <span className="eyebrow">The before and after</span>
            <h2 className="display-lg">
              Spreadsheets, WhatsApp and paper do not scale.
            </h2>
            <p>
              Most small rental operations run on three apps that do not talk to
              each other. One desk fixes that.
            </p>
          </div>
          <div className="ps-grid" data-reveal data-reveal-delay="1">
            <div className="ps-card problem">
              <h3>Today</h3>
              <ul className="ps-list">
                <li>
                  <span className="ps-mark">x</span>A booking sheet that two
                  people edit at once.
                </li>
                <li>
                  <span className="ps-mark">x</span>Quotes guessed over WhatsApp,
                  prices that drift.
                </li>
                <li>
                  <span className="ps-mark">x</span>Double-bookings you only
                  catch at pickup.
                </li>
                <li>
                  <span className="ps-mark">x</span>Licenses photographed and
                  lost in a phone gallery.
                </li>
              </ul>
            </div>
            <div className="ps-arrow" aria-hidden="true">
              &rarr;
            </div>
            <div className="ps-card solution">
              <h3>With Yabi</h3>
              <ul className="ps-list">
                <li>
                  <span className="ps-mark">+</span>One live calendar everyone
                  trusts.
                </li>
                <li>
                  <span className="ps-mark">+</span>Quotes computed on the
                  server, every time.
                </li>
                <li>
                  <span className="ps-mark">+</span>Two bookings can never hold
                  the same car.
                </li>
                <li>
                  <span className="ps-mark">+</span>Encrypted license capture,
                  filed with the booking.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 4. FEATURE BENTO */}
      <section className="section surface-panel" id="features">
        <div className="shell">
          <div className="section-head" data-reveal>
            <span className="eyebrow">What you get</span>
            <h2 className="display-lg">
              Everything a small fleet needs. Nothing it does not.
            </h2>
          </div>
          <div className="bento" data-reveal data-reveal-delay="1">
            <article className="bento-tile tile-feature tile-third">
              <span className="bento-num">01</span>
              <h3>Online booking, 24/7</h3>
              <p>
                Customers book and pay online. You wake up to confirmed
                reservations.
              </p>
            </article>
            <article className="bento-tile tile-wide tile-accent">
              <span className="bento-num">02</span>
              <h3>Never double-books</h3>
              <p>
                A database-level guarantee, not a checkbox. Two bookings can
                never hold the same car on overlapping dates.
              </p>
            </article>
            <article className="bento-tile tile-half">
              <span className="bento-num">03</span>
              <h3>Live fleet calendar</h3>
              <p>
                Every car, reservation, maintenance window and blackout on one
                planning board.
              </p>
            </article>
            <article className="bento-tile tile-half">
              <span className="bento-num">04</span>
              <h3>Instant, accurate quotes</h3>
              <p>
                Server-computed pricing with insurance tiers and add-ons. The
                price is always right.
              </p>
            </article>
            <article className="bento-tile tile-half">
              <span className="bento-num">05</span>
              <h3>Customer records &amp; licenses</h3>
              <p>
                Encrypted driver license capture, booking history, repeat
                customer recognition.
              </p>
            </article>
            <article className="bento-tile tile-half">
              <span className="bento-num">06</span>
              <h3>Reports that mean something</h3>
              <p>
                Utilization, revenue and fleet performance without exporting to
                a spreadsheet.
              </p>
            </article>
          </div>
        </div>
      </section>

      {/* 5. HOW IT WORKS */}
      <section className="section surface-sand">
        <div className="shell">
          <div className="section-head" data-reveal>
            <span className="eyebrow">How it works</span>
            <h2 className="display-lg">Live in days, not months.</h2>
          </div>
          <div className="steps" data-reveal data-reveal-delay="1">
            <div className="step">
              <span className="step-n">1</span>
              <h3>Load your fleet</h3>
              <p>
                We help you import every car, class and price. You do not start
                from a blank screen.
              </p>
            </div>
            <div className="step">
              <span className="step-n">2</span>
              <h3>Share your booking page</h3>
              <p>
                Put it on your site or send the link. Customers book in the
                browser, no app to download.
              </p>
            </div>
            <div className="step">
              <span className="step-n">3</span>
              <h3>Run it from one desk</h3>
              <p>
                Approve, plan and track. Every reservation, quote and license in
                one place.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 6. PRODUCT PEEK */}
      <section className="section surface-teal">
        <div className="shell">
          <div className="peek-grid">
            <div data-reveal>
              <span className="eyebrow on-teal">Inside the desk</span>
              <h2 className="display-lg">
                One planning board for the whole fleet.
              </h2>
              <p className="lead" style={{ color: "rgba(242,235,221,0.85)" }}>
                See every car at a glance. Bookings, service windows and
                blackouts on a single board, with conflict checks built in so
                the schedule is always honest.
              </p>
              <div className="hero-actions" style={{ marginTop: "2rem" }}>
                <Link className="btn btn-on-teal btn-lg" href="/early-access">
                  Request early access
                </Link>
              </div>
            </div>
            <div data-reveal data-reveal-delay="1">
              <ProductFrame title="Yabi · Fleet calendar" />
            </div>
          </div>
        </div>
      </section>

      {/* 7. PRICING TEASER */}
      <section className="section surface-panel">
        <div className="shell">
          <div className="section-head" data-reveal>
            <span className="eyebrow">Pricing</span>
            <h2 className="display-lg">Simple plans that grow with the fleet.</h2>
            <p>
              Start small, scale up when you add cars. Early adopters lock about
              30% off for life.
            </p>
          </div>
          <div className="price-grid" data-reveal data-reveal-delay="1">
            <div className="price-card">
              <span className="price-name">Starter</span>
              <p className="price-tba">Early-access pricing</p>
              <p className="price-cap">Up to 10 cars.</p>
              <ul className="price-feats">
                <li>Online booking</li>
                <li>Fleet calendar</li>
                <li>Instant quotes</li>
                <li>Customer records</li>
              </ul>
              <Link className="btn btn-ghost btn-block" href="/pricing">
                See details
              </Link>
            </div>
            <div className="price-card featured">
              <span className="price-badge">Most operators start here</span>
              <span className="price-name">Pro</span>
              <p className="price-tba">Early-access pricing</p>
              <p className="price-cap">Up to 40 cars.</p>
              <ul className="price-feats">
                <li>Everything in Starter</li>
                <li>Maintenance &amp; blackouts</li>
                <li>Reports &amp; notifications</li>
                <li>Multi-user access</li>
              </ul>
              <Link className="btn btn-primary btn-block" href="/pricing">
                See details
              </Link>
            </div>
            <div className="price-card">
              <span className="price-name">Business</span>
              <p className="price-tba">Early-access pricing</p>
              <p className="price-cap">Unlimited cars.</p>
              <ul className="price-feats">
                <li>Multi-location</li>
                <li>Custom domain</li>
                <li>Priority support</li>
                <li>Everything in Pro</li>
              </ul>
              <Link className="btn btn-ghost btn-block" href="/pricing">
                See details
              </Link>
            </div>
          </div>
          <div className="price-note" data-reveal>
            <p>
              <strong>Setup &euro;500 to 750</strong> one-time. We load and brand
              your fleet.
            </p>
            <p>
              <Link className="text-link" href="/pricing">
                See full pricing &rarr;
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* 8. FAQ (subset) */}
      <section className="section surface-sand">
        <div className="shell">
          <div className="section-head" data-reveal>
            <span className="eyebrow">Good questions</span>
            <h2 className="display-lg">The short answers.</h2>
          </div>
          <div className="faq" data-reveal data-reveal-delay="1">
            <div className="faq-item">
              <div className="faq-q">Do my customers need an app?</div>
              <p className="faq-a">
                No. They book in the browser. Nothing to download.
              </p>
            </div>
            <div className="faq-item">
              <div className="faq-q">Can I keep my own website?</div>
              <p className="faq-a">
                Yes. Link to your Yabi booking page today. An embeddable
                widget is coming.
              </p>
            </div>
            <div className="faq-item">
              <div className="faq-q">What about payments?</div>
              <p className="faq-a">Card payments run through Stripe.</p>
            </div>
            <div className="faq-item">
              <div className="faq-q">Is my data safe?</div>
              <p className="faq-a">
                Driver licenses are encrypted, security headers are hardened, and
                actions are audit-logged.
              </p>
            </div>
          </div>
          <p className="muted" style={{ marginTop: "1.5rem" }} data-reveal>
            <Link className="text-link" href="/pricing#faq">
              More questions, full pricing FAQ &rarr;
            </Link>
          </p>
        </div>
      </section>

      {/* 9. FINAL CTA BAND */}
      <section className="section surface-teal cta-band">
        <div className="shell" data-reveal>
          <h2>Run your fleet from one desk.</h2>
          <p>
            Join early access. We onboard you personally, load your fleet, and
            lock your early-adopter price for life.
          </p>
          <div className="cta-actions">
            <Link className="btn btn-primary btn-lg" href="/early-access">
              Request early access
            </Link>
            <Link className="btn btn-ghost-on-teal btn-lg" href="/pricing">
              See pricing
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
