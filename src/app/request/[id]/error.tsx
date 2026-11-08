"use client";
import { RouteError } from "@/components/site/RouteError";

export default function RequestError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <RouteError
      error={error}
      retry={retry}
      title="We couldn't load your request just now"
      body="Your request is safe: the agents keep working on it and the answer still arrives by email. This page only failed to load its progress."
    />
  );
}
