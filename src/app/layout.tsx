import type { ReactNode } from "react";

export const metadata = {
  title: "FleetDesk",
  description: "FleetDesk booking platform.",
};

// Minimal root layout so the App Router is satisfied. This starter is API-first;
// there is no client UI to attack-surface here.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
