import type { ReactNode } from "react";
import type { Metadata } from "next";
import { fontVars } from "@/app/fonts";
import { siteConfig } from "@/lib/site-config";
import "./public.css";

export const metadata: Metadata = { title: `Book a car | ${siteConfig.siteName}` };

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`pub ${fontVars}`}>
      <header className="pub-header">
        <div className="pub-header-inner">
          <a className="pub-brand" href={siteConfig.siteUrl} aria-label={`${siteConfig.siteName} home`}>
            <span className="pub-brand-mark" aria-hidden="true">
              ~&lt;
            </span>
            <span className="pub-brand-word">{siteConfig.siteName}</span>
          </a>
          <span className="pub-tag">We bring the car to you</span>
        </div>
      </header>
      {children}
    </div>
  );
}
