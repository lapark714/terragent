"use client";
/**
 * The second step, over the zoomed globe: what to know, over what period, and where to send it.
 * Bottom sheet on phones, floating panel on desktop. Posts to /api/requests and moves to the progress page.
 *
 * The API has no date fields yet, so the chosen period is appended to the question in plain words.
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { prettyCoords } from "./coords";
import { placeToLocation, type Place } from "./geocode";

const TOPICS = [
  { label: "Flooding", q: "How much of this area flooded?" },
  { label: "Fire damage", q: "How much of this area burned, and how badly?" },
  { label: "Forest loss", q: "Has forest been cleared here?" },
  { label: "Construction", q: "Has anything new been built or cleared here?" },
  { label: "Crop health", q: "How healthy is the vegetation on this land?" },
  { label: "Mining activity", q: "Are there indicators of new mining activity here?" },
] as const;

type Period = "latest" | "3m" | "1y" | "range";
const PERIODS: { id: Period; label: string }[] = [
  { id: "latest", label: "Latest" },
  { id: "3m", label: "Past 3 months" },
  { id: "1y", label: "Past year" },
  { id: "range", label: "Dates…" },
];

type Field = "location" | "question" | "email";
type Errors = Partial<Record<Field | "form", string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function periodText(p: Period, from: string, to: string): string {
  if (p === "3m") return "Time period: the past 3 months.";
  if (p === "1y") return "Time period: the past year.";
  if (p === "range" && from && to) return `Time period: compare ${from} with ${to}.`;
  if (p === "range" && from) return `Time period: since ${from}.`;
  return "";
}

export function AskSheet({ place, placeText, hello, onBack }: {
  /** Resolved place, or null when continuing with free text the search couldn't place. */
  place: Place | null;
  placeText: string;
  hello: string;
  onBack: () => void;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [period, setPeriod] = useState<Period>("latest");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [sending, setSending] = useState(false);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const sent = useRef(false);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  // Slide in on the frame after mount.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (window.matchMedia("(pointer: fine)").matches) questionRef.current?.focus();
    }, 350);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !sending && onBack();
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [onBack, sending]);

  function validate(): Errors {
    const e: Errors = {};
    if (question.trim().length < 5) e.question = "Ask your question in a few words or more.";
    if (!EMAIL_RE.test(email.trim())) e.email = "Enter the email address where the answer should go.";
    if (period === "range" && !from) e.form = "Pick a start date, or choose another time period.";
    return e;
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending || sent.current) return;
    const local = validate();
    setErrors(local);
    if (Object.keys(local).length) return;

    setSending(true);
    const website = new FormData(e.currentTarget).get("website");
    const fullQuestion = [question.trim(), periodText(period, from, to)].filter(Boolean).join("\n\n");
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: place ? placeToLocation(place) : placeText, question: fullQuestion, email: email.trim(), website }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201 && body.request_id) {
        sent.current = true; // keep the button disabled through navigation
        router.push(`/request/${body.request_id}`);
        return;
      }
      if (res.status === 400 && Array.isArray(body.issues)) {
        const next: Errors = {};
        for (const i of body.issues as { field: string | null; message: string }[]) {
          const f = (["location", "question", "email"].includes(i.field ?? "") ? i.field : "form") as Field | "form";
          next[f] ??= i.message;
        }
        setErrors(next);
      } else {
        setErrors({ form: body.message ?? "We couldn't send your request." });
      }
    } catch {
      setErrors({ form: "Your connection dropped before we got your request." });
    }
    setSending(false);
  }

  const fieldErr = (f: Field) =>
    errors[f] && (
      <p id={`${titleId}-${f}-err`} className="mt-1.5 text-sm text-alert">
        {errors[f]}
      </p>
    );

  const chip = (on: boolean) =>
    `rounded-full border px-3 py-1.5 text-sm transition-colors ${on ? "border-inbound-hi bg-inbound/20 text-fg" : "border-line-strong text-fg-2 hover:border-fg-3 hover:text-fg"}`;

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className={`pointer-events-auto relative flex h-full w-full sm:h-auto sm:max-h-[min(88svh,46rem)] flex-col overflow-hidden rounded-t-3xl border border-line-strong bg-panel/95 shadow-[0_-20px_60px_-10px_rgba(0,0,0,0.7)] backdrop-blur-xl transition-[transform,opacity] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none sm:rounded-3xl ${shown ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}
    >
      <span className="absolute top-2 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-line-strong sm:hidden" aria-hidden />
      {/* Place header */}
      <header className="flex items-start gap-3 border-b border-line px-5 pt-5 pb-4 sm:px-6 sm:pt-4">
        <div className="min-w-0 flex-1 pt-1">
          <p className="font-mono text-[11px] tracking-[0.12em] text-inbound-hi uppercase">Your place</p>
          <h2 id={titleId} className="stretch-semi truncate text-lg font-semibold">
            {place ? place.label : placeText}
          </h2>
          <p className="truncate text-sm text-fg-3">
            {place ? [place.detail, place.kind === "coords" || place.kind === "pin" ? null : prettyCoords(place)].filter(Boolean).join(" · ") : "We'll find it from your description"}
          </p>
        </div>
        <button type="button" onClick={onBack} disabled={sending}
          className="mt-1 shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-sm text-fg-2 hover:border-fg-3 hover:text-fg disabled:opacity-50">
          Change
        </button>
      </header>

      <form onSubmit={submit} noValidate className="scroll-quiet flex flex-col gap-6 overflow-y-auto px-5 pt-5 pb-6 sm:px-6">
        {/* Question */}
        <div>
          <label htmlFor={`${titleId}-q`} className="mb-2 block font-medium">What do you want to know?</label>
          <div className="mb-3 flex flex-wrap gap-2">
            {TOPICS.map((t) => (
              <button key={t.label} type="button" className={chip(question === t.q)} aria-pressed={question === t.q}
                onClick={() => setQuestion((cur) => (cur === t.q ? "" : t.q))}>
                {t.label}
              </button>
            ))}
          </div>
          <textarea
            ref={questionRef}
            id={`${titleId}-q`}
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Or ask in your own words: did the storm damage the roofs on our site?"
            aria-invalid={!!errors.question}
            aria-describedby={errors.question ? `${titleId}-question-err` : undefined}
            className="w-full resize-none rounded-xl border border-line-strong bg-space px-3.5 py-3 text-fg placeholder:text-fg-3 focus:border-inbound-hi focus:outline-none aria-[invalid=true]:border-alert"
          />
          {fieldErr("question")}
        </div>

        {/* Period */}
        <fieldset>
          <legend className="mb-2 font-medium">Time period</legend>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line-strong bg-space p-1 sm:grid-cols-4">
            {PERIODS.map((p) => (
              <label key={p.id}
                className={`cursor-pointer rounded-lg px-2 py-2 text-center text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-inbound-hi ${period === p.id ? "bg-raised text-fg" : "text-fg-3 hover:text-fg"}`}>
                <input type="radio" name="period" value={p.id} checked={period === p.id} onChange={() => setPeriod(p.id)} className="sr-only" />
                {p.label}
              </label>
            ))}
          </div>
          {period === "range" && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm text-fg-3">
                From
                <input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)}
                  className="rounded-lg border border-line-strong bg-space px-3 py-2 text-fg [color-scheme:dark] focus:border-inbound-hi focus:outline-none" />
              </label>
              <label className="flex flex-col gap-1 text-sm text-fg-3">
                To <span className="sr-only">(optional)</span>
                <input type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)}
                  className="rounded-lg border border-line-strong bg-space px-3 py-2 text-fg [color-scheme:dark] focus:border-inbound-hi focus:outline-none" />
              </label>
            </div>
          )}
        </fieldset>

        {/* Email */}
        <div>
          <label htmlFor={`${titleId}-email`} className="mb-2 block font-medium">Where should we send the answer?</label>
          <input
            id={`${titleId}-email`}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? `${titleId}-email-err` : undefined}
            className="w-full rounded-xl border border-line-strong bg-space px-3.5 py-3 text-fg placeholder:text-fg-3 focus:border-inbound-hi focus:outline-none aria-[invalid=true]:border-alert"
          />
          {fieldErr("email")}
        </div>

        {/* Honeypot */}
        <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor={`${titleId}-website`}>Website</label>
          <input id={`${titleId}-website`} name="website" tabIndex={-1} autoComplete="off" />
        </div>

        {(errors.form || errors.location) && (
          <div role="alert" className="rounded-xl border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-fg">
            <p>{errors.location ?? errors.form}</p>
            <p className="mt-1 text-fg-2">
              Try again, or email{" "}
              <a href={`mailto:${hello}`} className="underline decoration-line-strong underline-offset-4 hover:decoration-fg">{hello}</a>{" "}
              with your place and question.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <button type="submit" disabled={sending}
            className="flex items-center justify-center gap-2 rounded-xl bg-inbound px-4 py-3.5 font-semibold text-space transition-colors hover:bg-inbound-hi disabled:cursor-wait disabled:opacity-75">
            {sending && <span className="size-4 animate-spin rounded-full border-2 border-space/40 border-t-space motion-reduce:animate-none" aria-hidden />}
            {sending ? "Sending to the agents…" : "Get my satellite report"}
          </button>
          <p className="text-center text-xs leading-relaxed text-fg-3">
            AI agents plan, analyze and verify your report. You&apos;ll get it by email, usually within minutes.
          </p>
        </div>
      </form>
    </section>
  );
}
