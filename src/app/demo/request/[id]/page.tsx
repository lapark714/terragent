import type { Metadata } from "next";
import { DemoRequestView } from "@/components/demo/DemoRequestView";
import { helloAddress } from "@/components/site/contact";
import { DEMO_PERIOD, DEMO_QUESTION, SITES } from "@/lib/demo/yc";

export const metadata: Metadata = { title: "Your request" };

const DEFAULT_LOCATION = `${SITES.sf.name}, ${SITES.sf.detail} · ${SITES.sf.lat.toFixed(4)}, ${SITES.sf.lng.toFixed(4)}`;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Synthetic: any id works, nothing is read from the database. Place and question come from the demo ask form. */
export default async function DemoRequestPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const speed = Number(one(sp.speed));
  return (
    <DemoRequestView
      id={id}
      question={one(sp.q)?.slice(0, 600) || `${DEMO_QUESTION}\n\n${DEMO_PERIOD}`}
      location={one(sp.loc)?.slice(0, 200) || DEFAULT_LOCATION}
      speed={Number.isFinite(speed) && speed > 0 ? Math.min(speed, 20) : 1}
      hello={helloAddress()}
    />
  );
}
