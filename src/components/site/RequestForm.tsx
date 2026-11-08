"use client";
/** The portal: place + question + email. Posts JSON for a smooth hand-off; still works as a plain form without JS. */
import { useRouter } from "next/navigation";
import { useState } from "react";

const EXAMPLES = [
  { place: "Lahaina, Maui, Hawaii", question: "How much of the town burned in the August 2023 fire?" },
  { place: "-9.97, -63.03", question: "Has forest been cleared on this land since 2022?" },
  { place: "Port Arthur, Texas", question: "Was there flooding near the refineries after the last storm?" },
];

type Field = "location" | "question" | "email" | "name" | "company";
type Errors = Partial<Record<Field | "form", string>>;

const inputClass =
  "w-full rounded-md border border-line-strong bg-space px-3 py-2.5 text-fg placeholder:text-fg-3 hover:border-fg-3 focus:border-inbound-hi focus:outline-none aria-[invalid=true]:border-alert";

export function RequestForm() {
  const router = useRouter();
  const [values, setValues] = useState<Record<Field, string>>({ location: "", question: "", email: "", name: "", company: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [sending, setSending] = useState(false);

  const set = (field: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [field]: e.target.value }));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    setErrors({});
    const website = new FormData(e.currentTarget).get("website");
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...values, website }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) {
        router.push(`/request/${body.request_id}`);
        return;
      }
      if (res.status === 400 && Array.isArray(body.issues)) {
        const next: Errors = {};
        for (const i of body.issues as { field: Field | null; message: string }[]) next[i.field ?? "form"] ??= i.message;
        setErrors(next);
      } else {
        setErrors({ form: body.message ?? "Something went wrong sending your request. Try again, or email us." });
      }
    } catch {
      setErrors({ form: "Your browser couldn't reach us. Check the connection and try again." });
    }
    setSending(false);
  }

  const errorId = (f: Field) => (errors[f] ? `${f}-error` : undefined);
  const fieldError = (f: Field) =>
    errors[f] && (
      <p id={`${f}-error`} className="mt-1.5 text-sm text-alert">
        {errors[f]}
      </p>
    );

  return (
    <form action="/api/requests" method="post" onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div>
        <label htmlFor="location" className="mb-1.5 block text-sm font-medium text-fg">
          Place
        </label>
        <input id="location" name="location" required autoComplete="street-address" placeholder="An address, a town, an area or coordinates"
          value={values.location} onChange={set("location")} aria-invalid={!!errors.location} aria-describedby={errorId("location")} className={inputClass} />
        {fieldError("location")}
      </div>
      <div>
        <label htmlFor="question" className="mb-1.5 block text-sm font-medium text-fg">
          Question
        </label>
        <textarea id="question" name="question" required rows={3} placeholder="What do you want to know about this place?"
          value={values.question} onChange={set("question")} aria-invalid={!!errors.question} aria-describedby={errorId("question")} className={`${inputClass} resize-y`} />
        {fieldError("question")}
      </div>
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-fg">
          Email for the answer
        </label>
        <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com"
          value={values.email} onChange={set("email")} aria-invalid={!!errors.email} aria-describedby={errorId("email")} className={inputClass} />
        {fieldError("email")}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="mb-1.5 block text-sm text-fg-2">
            Name <span className="text-fg-3">(optional)</span>
          </label>
          <input id="name" name="name" autoComplete="name" value={values.name} onChange={set("name")} className={inputClass} />
        </div>
        <div>
          <label htmlFor="company" className="mb-1.5 block text-sm text-fg-2">
            Company <span className="text-fg-3">(optional)</span>
          </label>
          <input id="company" name="company" autoComplete="organization" value={values.company} onChange={set("company")} className={inputClass} />
        </div>
      </div>
      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {errors.form && (
        <p role="alert" className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-fg">
          {errors.form}
        </p>
      )}
      <button type="submit" disabled={sending}
        className="rounded-md bg-inbound px-4 py-3 font-semibold text-space transition-colors hover:bg-inbound-hi disabled:cursor-wait disabled:opacity-70">
        {sending ? "Sending your request…" : "Send request"}
      </button>

      <div className="border-t border-line pt-4">
        <p className="mb-2 text-sm text-fg-3">Or start from an example</p>
        <ul className="flex flex-col gap-1.5">
          {EXAMPLES.map((ex) => (
            <li key={ex.place}>
              <button type="button" onClick={() => setValues((v) => ({ ...v, location: ex.place, question: ex.question }))}
                className="text-left text-sm text-fg-2 underline decoration-line-strong underline-offset-4 hover:text-fg hover:decoration-fg-3">
                {ex.question} <span className="text-fg-3">({ex.place})</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}
