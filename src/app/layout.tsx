import type { ReactNode } from "react";
import "./tokens.css";

export const metadata = {
  title: "Yabi",
  description: "Yabi booking platform.",
};

// Minimal root layout. tokens.css is the one source of design tokens for every
// scope below (admin shell, public booking, marketing); see tokens.css.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
