import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ReportView } from "@/components/report/ReportView";
import { getPublicReport } from "@/lib/dashboard/public";

type Props = { params: Promise<{ token: string }> };

/** Metadata and page share one lookup per request. */
const loadReport = cache(getPublicReport);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const report = await loadReport((await params).token);
  return { title: report?.title ?? "Report", robots: { index: false } };
}

export default async function ReportPage({ params }: Props) {
  const report = await loadReport((await params).token);
  if (!report) notFound();
  return <ReportView report={report} />;
}
