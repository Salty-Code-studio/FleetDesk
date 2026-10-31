import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressRing, StepShell, HandScreen, FinishScreen, CheckList } from "../app/admin/(shell)/inspect/wizard-ui";

/** Render tests for the Flow Desk phase 5 wizard pieces: one coral button per
 *  screen, no numbered step labels, open items never ticked. */
const coralCount = (html: string) => (html.match(/class="wiz-btn primary[^"]*"/g) ?? []).length;

describe("wizard UI render", () => {
  it("the ring names its progress and ticks only when full", () => {
    const half = renderToStaticMarkup(<ProgressRing done={3} total={6} label="Check-in" />);
    expect(half).toContain('aria-label="Check-in 50% done"');
    expect(half).not.toContain("wiz-ring__tick");
    const full = renderToStaticMarkup(<ProgressRing done={6} total={6} label="Check-in" />);
    expect(full).toContain("is-full");
    expect(full).toContain("wiz-ring__tick");
  });

  it("a step has no 'Step N of M' label and one coral button", () => {
    const html = renderToStaticMarkup(
      <StepShell kicker="Check-out" ring={{ done: 1, total: 4 }} title="Odometer and fuel" onBack={() => {}} onNext={() => {}}>
        <p>body</p>
      </StepShell>,
    );
    expect(html).not.toMatch(/Step \d+ of \d+/);
    expect(html).toContain("Check-out");
    expect(coralCount(html)).toBe(1);
  });

  it("the handover screen has the operator name behind and one coral button", () => {
    const html = renderToStaticMarkup(
      <HandScreen backWord="Yabi" title="Hand the phone to Maria" body="..." goLabel="Show me the rules" onGo={() => {}} onBack={() => {}} />,
    );
    expect(html).toContain('class="wiz-hand__back" aria-hidden="true">Yabi<');
    expect(html).toContain("Hand the phone to Maria");
    expect(coralCount(html)).toBe(1);
  });

  it("the finish screen marks open lines open", () => {
    const html = renderToStaticMarkup(
      <FinishScreen word="Out." title="The car is on the road" doneLabel="Back to Today" onDone={() => {}}
        lines={[{ text: "Paid in full." }, { text: "USD 150 still open on the booking.", open: true }]} />,
    );
    expect(html).toContain('<li>Paid in full.</li>');
    expect(html).toContain('<li class="is-open">USD 150 still open on the booking.</li>');
    expect(coralCount(html)).toBe(1);
  });

  it("the checklist says done or open", () => {
    const html = renderToStaticMarkup(<CheckList items={[{ label: "Keys returned", ok: true }, { label: "Borg settled", ok: false }]} />);
    expect(html).toContain('class="state ok">done<');
    expect(html).toContain('class="state todo">open<');
  });
});
