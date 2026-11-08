import type { Metadata } from "next";
import { ReportView } from "@/components/report/ReportView";
import { demoReport, REPORT_TITLE } from "@/lib/demo/yc";

export const metadata: Metadata = { title: REPORT_TITLE };

/**
 * The demo report: the real report page (ReportView) with the real pipeline outputs for YC's Dogpatch office
 * (yc-run.json, public/demo/yc-sf/). Only the delivery is replayed.
 */
export default async function DemoReportPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ option?: string | string[] }>;
}) {
  const [{ id }, { option }] = await Promise.all([params, searchParams]);
  const paid = option === "B" || option === "C";
  return <ReportView report={demoReport(id, { paid })} home="/demo" demo />;
}
