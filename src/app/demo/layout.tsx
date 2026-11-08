import type { Metadata } from "next";
import { DemoBadge } from "@/components/demo/DemoBadge";

/**
 * /demo: a copy of the site for live demos. Every page under here is synthetic: no database, no agents, no email,
 * no payments. The badge stays on screen throughout.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <DemoBadge />
    </>
  );
}
