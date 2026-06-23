import type { ReactNode } from "react";
import "./public.css";

export const metadata = { title: "Book a car | FleetDesk" };

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="pub-header">
        <div className="wrap">
          <a className="logo" href="https://fleetdesk.app" style={{ color: "#fff", textDecoration: "none" }}>
            FLEET<b>DESK</b>
          </a>
          <span className="tag">We bring the car to you</span>
        </div>
      </header>
      {children}
    </>
  );
}
