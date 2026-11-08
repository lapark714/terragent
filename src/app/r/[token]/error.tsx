"use client";
import { RouteError } from "@/components/site/RouteError";

export default function ReportError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="This report didn't load"
      body="The report itself is fine; we couldn't fetch it this time. Try again in a moment, or use the copy in your email."
    />
  );
}
