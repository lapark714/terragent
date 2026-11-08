"use client";
/**
 * What is waiting on a founder, with the controls to decide. Anyone can see the queue; acting needs the
 * admin token, and every action is posted with the founder's name and reason to the public intervention log.
 */
import { useState } from "react";
import type { Approvals } from "@/lib/dashboard/types";
import { actorLabel, clockUtc, usd } from "../format";
import { Quiet } from "./Panel";
import { useAdminSession, type AdminSession } from "./useAdminSession";

type Choice = { label: string; primary?: boolean; body: Record<string, unknown> };

async function postAdmin(session: AdminSession, action: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/admin/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": session.token },
    body: JSON.stringify({ ...body, actor: session.actor }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, message: (json.done ?? json.message ?? json.error ?? `Failed (${res.status})`) as string };
}

/** Buttons for one decision; picking one asks for the reason before anything is sent. */
function Decide({ action, choices, session, onDone, onUnauthorized }: {
  action: string;
  choices: Choice[];
  session: AdminSession | null;
  onDone: () => void;
  onUnauthorized: () => void;
}) {
  const [picked, setPicked] = useState<Choice | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (!session) return <p className="text-xs text-fg-3">Unlock founder controls to act on this.</p>;

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!picked || !session) return;
    setBusy(true);
    const r = await postAdmin(session, action, { ...picked.body, reason });
    setBusy(false);
    setResult(r);
    if (r.status === 401) onUnauthorized();
    if (r.ok) {
      setPicked(null);
      setReason("");
      onDone();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {!picked ? (
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => (
            <button key={c.label} type="button" onClick={() => { setPicked(c); setResult(null); }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${c.primary ? "bg-inbound text-space hover:bg-inbound-hi" : "border border-line-strong text-fg hover:border-fg-3"}`}>
              {c.label}
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={confirm} className="flex flex-col gap-2">
          <label className="text-xs text-fg-2">
            Why? This goes in the public intervention log.
            <input autoFocus required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong bg-space px-2.5 py-1.5 text-sm text-fg focus:border-inbound-hi focus:outline-none" />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-md bg-inbound px-3 py-1.5 text-sm font-medium text-space hover:bg-inbound-hi disabled:opacity-60">
              {busy ? "Sending…" : picked.label}
            </button>
            <button type="button" onClick={() => setPicked(null)} className="rounded-md px-3 py-1.5 text-sm text-fg-2 hover:text-fg">
              Cancel
            </button>
          </div>
        </form>
      )}
      {result && <p role="status" className={`text-xs ${result.ok ? "text-fg-2" : "text-alert"}`}>{result.message}</p>}
    </div>
  );
}

function Unlock({ onSave }: { onSave: (s: AdminSession) => void }) {
  const [actor, setActor] = useState("");
  const [token, setToken] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave({ actor: actor.trim(), token: token.trim() }); }} className="flex flex-wrap items-end gap-3">
      <label className="text-xs text-fg-2">
        Your name
        <input required minLength={2} value={actor} onChange={(e) => setActor(e.target.value)} autoComplete="name"
          className="mt-1 block w-40 rounded-md border border-line-strong bg-space px-2.5 py-1.5 text-sm text-fg focus:border-inbound-hi focus:outline-none" />
      </label>
      <label className="text-xs text-fg-2">
        Admin token
        <input required type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off"
          className="mt-1 block w-56 rounded-md border border-line-strong bg-space px-2.5 py-1.5 text-sm text-fg focus:border-inbound-hi focus:outline-none" />
      </label>
      <button type="submit" className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg hover:border-fg-3">
        Unlock founder controls
      </button>
    </form>
  );
}

function Group({ title, count, className = "", children }: { title: string; count: number | null; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-3 bg-panel p-4 ${className}`}>
      <h3 className="flex items-baseline justify-between text-sm font-semibold">
        {title}
        {count !== null && <span className="font-normal text-fg-3 tabular-nums">{count} waiting</span>}
      </h3>
      {children}
    </div>
  );
}

export function ApprovalsPanel({ approvals: a, offline = false, onChanged }: { approvals: Approvals; offline?: boolean; onChanged: () => void }) {
  const { session, save } = useAdminSession();
  const common = { session, onDone: onChanged, onUnauthorized: () => save(null) };
  const naive = a.naive.state === "ok" ? a.naive.data : [];

  return (
    <section aria-labelledby="approvals-title" className="flex flex-col gap-px bg-line">
      <header className="flex flex-wrap items-end justify-between gap-4 bg-panel px-4 py-4">
        <div>
          <h2 id="approvals-title" className="stretch-semi text-[0.95rem] font-semibold">Waiting on a founder</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-3">
            The only steps our rules reserve for people: paid data, prices above the cap, first sends, paused tool calls.
            {offline && " Local demo mode: decisions write to the demo database only."}
          </p>
        </div>
        {session ? (
          <p className="text-sm text-fg-2">
            Acting as <span className="text-fg">{session.actor}</span>.{" "}
            <button type="button" onClick={() => save(null)} className="text-fg-3 underline underline-offset-4 hover:text-fg">Lock</button>
          </p>
        ) : (
          <Unlock onSave={save} />
        )}
      </header>

      <div className="grid gap-px md:grid-cols-2 xl:grid-cols-3">
        <Group title="Paused agent actions" count={a.naive.state === "ok" ? naive.length : null}>
          {a.naive.state === "offline" && <Quiet>Local demo mode: Naïve isn&apos;t called, so no paused agent action shows here.</Quiet>}
          {a.naive.state === "not_configured" && <Quiet>Naïve isn&apos;t connected on this deployment.</Quiet>}
          {a.naive.state === "error" && <Quiet>Couldn&apos;t read Naïve approvals ({a.naive.message}).</Quiet>}
          {a.naive.state === "ok" && !naive.length && <Quiet>No agent is waiting for a decision.</Quiet>}
          {naive.map((p) => (
            <div key={p.toolCallId} className="flex flex-col gap-2 border-t border-line pt-3 first:border-0 first:pt-0">
              <p className="text-sm">
                <span className="font-medium">{actorLabel(p.agent)}</span> <span className="text-fg-2">wants to run</span>{" "}
                <span className="font-mono text-xs">{p.tool}</span>
              </p>
              <pre className="scroll-quiet max-h-28 overflow-auto rounded bg-space p-2 font-mono text-[11px] leading-snug text-fg-2">{JSON.stringify(p.args, null, 1)}</pre>
              <Decide action="naive-approval" {...common} choices={[
                // Only calls on the approvable list can be allowed from here (and never a signup or login); the server checks too.
                ...(p.approvable ? [{ label: "Allow", primary: true, body: { session_id: p.sessionId, tool_call_id: p.toolCallId, decision: "allow" } }] : []),
                { label: "Deny", body: { session_id: p.sessionId, tool_call_id: p.toolCallId, decision: "deny" } },
              ]} />
              {!p.approvable && (
                <p className="text-xs text-fg-3">Our rules never let this call be allowed from the dashboard, only denied. If it truly must run, decide it in the Naïve console.</p>
              )}
            </div>
          ))}
        </Group>

        <Group title="Paid data orders" count={a.orders.length}>
          {!a.orders.length && <Quiet>No paid orders are held. Agents are delivering from free data.</Quiet>}
          {a.orders.map((o) => (
            <div key={o.id} className="flex flex-col gap-2 border-t border-line pt-3 first:border-0 first:pt-0">
              <p className="text-sm">
                <span className="font-medium">{o.product}</span> <span className="text-fg-2">from {o.provider}</span>
              </p>
              <p className="text-xs text-fg-3">
                {o.request && <span className="font-mono">{o.request}</span>} est. {usd(o.estCostUsd)}
                {o.supplierQuoteUsd !== null && `, supplier quoted ${usd(o.supplierQuoteUsd)}`}
                {o.areaKm2 !== null && `, ${o.areaKm2} km²`}, held since {clockUtc(o.at)} UTC
              </p>
              <p className="line-clamp-3 text-[13px] text-fg-2">{o.justification}</p>
              <Decide action="order" {...common} choices={[
                { label: "Approve purchase", primary: true, body: { order_id: o.id, decision: "approve" } },
                { label: "Reject", body: { order_id: o.id, decision: "reject" } },
              ]} />
              <p className="text-xs text-fg-3">
                Approving records the decision; a founder still buys the data by hand. If an agent is paused on this order, this answers it too.
              </p>
            </div>
          ))}
        </Group>

        <Group title="Quotes above the cap" count={a.quotes.length}>
          {!a.quotes.length && <Quiet>No quotes are held. Quotes at or under the auto-approve cap go out on their own.</Quiet>}
          {a.quotes.map((q) => (
            <div key={q.id} className="flex flex-col gap-2 border-t border-line pt-3 first:border-0 first:pt-0">
              <p className="text-sm">
                <span className="font-medium tabular-nums">{usd(q.priceUsd)}</span> <span className="text-fg-2">for</span>{" "}
                <span className="font-mono text-xs">{q.request}</span>
              </p>
              {q.question && <p className="line-clamp-2 text-[13px] text-fg-2">{q.question}</p>}
              <p className="text-xs text-fg-3">
                {q.lineItems.map((i) => `${i.label} ${usd(i.amountUsd)}`).join(" + ")}, held since {clockUtc(q.at)} UTC
              </p>
              <Decide action="quote" {...common} choices={[
                { label: "Approve quote", primary: true, body: { quote_id: q.id, decision: "approve" } },
                { label: "Reject", body: { quote_id: q.id, decision: "reject" } },
              ]} />
              <p className="text-xs text-fg-3">
                Approving hands the quote to the customer agent, which emails it to the customer. Rejecting sends it back to pricing with your reason.
              </p>
            </div>
          ))}
        </Group>

        <Group title="Outreach templates" count={a.templates.length}>
          {!a.templates.length && <Quiet>No draft templates. Outreach only sends from approved ones.</Quiet>}
          {a.templates.map((t) => (
            <div key={t.id} className="flex flex-col gap-2 border-t border-line pt-3 first:border-0 first:pt-0">
              <p className="text-sm">
                <span className="font-medium">{t.subject}</span>{" "}
                <span className="text-fg-3">({t.playbook}, {t.version})</span>
              </p>
              <pre className="scroll-quiet max-h-32 overflow-auto rounded bg-space p-2 font-sans text-[12px] leading-snug whitespace-pre-wrap text-fg-2">{t.body}</pre>
              <Decide action="template" {...common} choices={[
                { label: "Approve template", primary: true, body: { template_id: t.id, decision: "approve" } },
                { label: "Retire", body: { template_id: t.id, decision: "retire" } },
              ]} />
            </div>
          ))}
        </Group>

        <Group title="Inboxes" count={null} className="md:col-span-2">
          <p className="text-xs text-fg-3">An unarmed inbox can only email the team. Arm it after approving its first real send.</p>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            {a.inboxes.map((i) => (
              <div key={i.role} className="flex min-w-0 flex-col gap-2 border-t border-line pt-3">
                <p className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-mono text-xs text-fg-2">{i.address}</span>
                  <span className={i.armed ? "text-fg" : "text-fg-3"}>{i.armed ? "Armed" : "Not armed"}</span>
                </p>
                <Decide action="inbox" {...common} choices={[
                  i.armed
                    ? { label: `Disarm ${i.role}`, body: { inbox: i.role, armed: false } }
                    : { label: `Arm ${i.role}`, primary: true, body: { inbox: i.role, armed: true } },
                ]} />
              </div>
            ))}
          </div>
        </Group>
      </div>
    </section>
  );
}
