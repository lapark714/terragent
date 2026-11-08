"use client";
/**
 * The /demo tracking page: the real RequestProgressView pieces (step track, outcome, agent card, timeline), fed by
 * the scripted playback instead of polling. Plus a live agent log, which only the demo has.
 *
 * Presenter controls: press N (or →) to jump to the next step; ?speed=2 plays twice as fast. The run survives a
 * reload (sessionStorage, per request id) so a refresh on stage doesn't restart it.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentNow } from "@/components/request/AgentNow";
import { Elapsed } from "@/components/request/Elapsed";
import { Outcome } from "@/components/request/Outcome";
import { agentIsWorking, headingOf, ownerSince, showsChosenOption, splitLocation, trackOf } from "@/components/request/progress";
import { chosenText } from "@/components/request/quote";
import { StepTrack } from "@/components/request/StepTrack";
import { Timeline } from "@/components/request/Timeline";
import { LogoLockup } from "@/components/site/Logo";
import { actorLabel } from "@/components/format";
import type { QuoteOptionId } from "@/lib/domain";
import { demoFrame, skipToNext, type DemoClock, type DemoLogEntry } from "@/lib/demo/playback";

const storeKey = (id: string) => `terragent-demo:${id}`;

function loadClock(id: string): Partial<DemoClock> | null {
  try {
    const raw = sessionStorage.getItem(storeKey(id));
    return raw ? (JSON.parse(raw) as Partial<DemoClock>) : null;
  } catch {
    return null;
  }
}

function saveClock(c: DemoClock) {
  try {
    sessionStorage.setItem(storeKey(c.id), JSON.stringify(c));
  } catch {
    // Private window or blocked storage: the run just won't survive a reload.
  }
}

/** Ticks fast enough that log lines land on time; the real page polls, this just re-reads the script. */
function useTick(ms: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [ms]);
  return now;
}

export function DemoRequestView({ id, question, location, speed, hello }: {
  id: string;
  question: string;
  location: string;
  speed: number;
  hello: string;
}) {
  const now = useTick(250);
  const [clock, setClock] = useState<DemoClock | null>(null);

  // Start (or resume) the run on the client only, so server and client render the same first frame.
  useEffect(() => {
    const t = setTimeout(() => {
      const c: DemoClock = {
        id, question, location, startedAt: Date.now(), acceptedAt: null, optionId: null, skipPre: 0, skipPost: 0,
        ...loadClock(id),
        speed,
      };
      saveClock(c);
      setClock(c);
    }, 0);
    return () => clearTimeout(t);
  }, [id, question, location, speed]);

  const update = useCallback((patch: Partial<DemoClock>) => {
    setClock((c) => {
      if (!c) return c;
      const next = { ...c, ...patch };
      saveClock(next);
      return next;
    });
  }, []);

  const onDemoAccept = useCallback((optionId: QuoteOptionId) => update({ acceptedAt: Date.now(), optionId }), [update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key !== "n" && e.key !== "N" && e.key !== "ArrowRight") return;
      setClock((c) => {
        if (!c) return c;
        const skip = skipToNext(c, Date.now());
        if (!skip) return c;
        const next = { ...c, ...skip };
        saveClock(next);
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const where = splitLocation(location);
  const frame = clock && now ? demoFrame(clock, Math.max(now, clock.startedAt)) : null;
  const p = frame?.progress;

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-4 py-4 sm:px-6 sm:py-5">
      <header className="mb-10 flex items-center justify-between gap-4 sm:mb-14">
        <Link href="/demo" aria-label="Terragent home" className="text-fg">
          <LogoLockup className="h-7 sm:h-8" label="" />
        </Link>
        <span className="font-mono text-xs text-fg-3">{id}</span>
      </header>

      <main className="flex-1">
        {where.name && (
          <p className="mb-2 text-sm text-fg-3">
            {where.name}
            {where.coords && <span className="ml-2 font-mono text-xs">{where.coords}</span>}
          </p>
        )}
        <h1 className="stretch-wide mb-8 text-[clamp(1.6rem,4.5vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.02em] text-balance">
          {question.split("\n\n")[0]}
        </h1>

        {p ? (
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-4">
              <StepTrack {...trackOf(p)} />
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="stretch-semi text-2xl font-semibold" aria-live="polite">{headingOf(p)}</p>
                <p className="text-sm text-fg-3">
                  {p.terminal ? "Took " : "Asked "}
                  <Elapsed since={p.createdAt} until={p.terminal ? p.updatedAt : null} className="text-fg-2" />
                  {p.terminal ? "" : " ago"}
                </p>
              </div>
              {showsChosenOption(p) && p.quote?.accepted_option_id && (
                <p className="text-fg-2">{chosenText(p.quote, p.quote.accepted_option_id, p.quote.accepted_at)}.</p>
              )}
              {p.status === "revising" && (
                <p className="text-fg-2">The verifier sent the report back for another pass. This is normal, and it&apos;s how weak answers get caught.</p>
              )}
            </div>

            <Outcome progress={p} hello={hello} onDemoAccept={onDemoAccept} demo />
            {agentIsWorking(p) && <AgentNow owner={p.owner} since={ownerSince(p)} />}
            <AgentLog entries={frame.log} startedAt={p.createdAt} live={!p.terminal} />
            <Timeline events={p.events} />
          </div>
        ) : (
          <div className="h-64 animate-pulse rounded-lg bg-panel motion-reduce:animate-none" aria-label="Loading" />
        )}
      </main>

      <footer className="mt-16 border-t border-line pt-5 text-sm leading-relaxed text-fg-3">
        Keep this page open or close it: the answer also arrives by email. Terragent is run by AI agents.
      </footer>
    </div>
  );
}

const ACTOR_TONE: Record<string, string> = {
  coordinator: "text-fg-2",
  "comms-customer": "text-human",
  planner: "text-forest",
  acquisition: "text-mining",
  pricing: "text-mining",
  analytics: "text-inbound-hi",
  interpreter: "text-inbound-hi",
  verifier: "text-alert",
};

/** The agents' working notes, streamed as they land. Monospace, newest at the bottom, auto-scrolling. */
function AgentLog({ entries, startedAt, live }: { entries: DemoLogEntry[]; startedAt: string; live: boolean }) {
  const box = useRef<HTMLOListElement>(null);
  const count = entries.length;
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  const t0 = Date.parse(startedAt);
  const stamp = (at: string) => {
    const s = Math.max(0, Math.round((Date.parse(at) - t0) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium text-fg-2">Agent log</h2>
        {live && (
          <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-inbound-hi uppercase">
            <span className="beacon inline-block size-1.5 rounded-full bg-inbound-hi text-inbound" aria-hidden />
            Live
          </span>
        )}
      </div>
      <ol ref={box} className="scroll-quiet flex max-h-72 flex-col gap-1.5 overflow-y-auto rounded-lg border border-line bg-space p-4 font-mono text-[12.5px] leading-relaxed">
        {entries.map((e, i) => (
          <li key={`${e.at}-${i}`} className="grid grid-cols-[3rem_7.5rem_1fr] gap-x-2 animate-[demo-in_400ms_ease-out] motion-reduce:animate-none max-sm:grid-cols-[3rem_1fr]">
            <span className="text-fg-3 tabular-nums">{stamp(e.at)}</span>
            <span className={`truncate ${ACTOR_TONE[e.actor] ?? "text-fg-2"} max-sm:hidden`}>{actorLabel(e.actor)}</span>
            <span className="text-fg-2">
              <span className={`sm:hidden ${ACTOR_TONE[e.actor] ?? "text-fg-2"}`}>{actorLabel(e.actor)} · </span>
              {e.text}
            </span>
          </li>
        ))}
        {live && (
          <li className="grid grid-cols-[3rem_1fr] gap-x-2 text-fg-3">
            <span />
            <span className="animate-pulse motion-reduce:animate-none">▍</span>
          </li>
        )}
      </ol>
    </section>
  );
}
