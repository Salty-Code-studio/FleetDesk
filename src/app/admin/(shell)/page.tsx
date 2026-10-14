// Replaced by the real Today screen in Task 7 of the phase 1 plan.
import Link from "next/link";

export default function TodayPlaceholder() {
  return (
    <>
      <h1>Today</h1>
      <p className="sub">The Today screen is on its way. <Link href="/admin/board">Open the board</Link>.</p>
    </>
  );
}
