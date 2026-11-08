"use client";
/**
 * "Where on Earth?" One input that takes an address, a place name, coordinates or a map link.
 * Coordinates and built-in places suggest instantly; street addresses come from the OSM search a beat later.
 * If nothing resolves, Enter still continues with the text as typed (agents can read it).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { instant, mergePlaces, searchRemote, type Place } from "./geocode";

const DEBOUNCE_MS = 280;

const KIND_ICON: Record<Place["kind"], string> = {
  coords: "M8 1v3M8 12v3M1 8h3M12 8h3M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z",
  pin: "M8 14s5-4.6 5-8.2A5 5 0 0 0 3 5.8C3 9.4 8 14 8 14Zm0-6.2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  address: "M2.5 7 8 2.5 13.5 7v6.5h-11V7Zm4 6.5V10h3v3.5",
  place: "M8 14s5-4.6 5-8.2A5 5 0 0 0 3 5.8C3 9.4 8 14 8 14Zm0-6.2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  region: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM1.5 8h13M8 1.5c2 2 2.6 4.2 2.6 6.5S10 12.5 8 14.5C6 12.5 5.4 10.3 5.4 8S6 3.5 8 1.5Z",
};

export function PlaceSearch({ onChoose, onFreeText, autoFocus = false }: {
  onChoose: (p: Place) => void;
  /** Enter with nothing resolved: continue with the raw text. */
  onFreeText: (text: string) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  /** Address results, tagged with the query they answer so stale ones never show. */
  const [remote, setRemote] = useState<{ q: string; items: Place[] | null; failed: boolean }>({ q: "", items: null, failed: false });
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const statusId = useId();

  useEffect(() => {
    if (autoFocus && window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, [autoFocus]);

  // Instant layer, computed during render: coordinates beat everything, then the built-in places.
  const text = q.trim();
  const local = useMemo(() => instant(text), [text]);
  const wantsRemote = !local.coords && text.length >= 3;
  const remoteFresh = remote.q === text;
  const items: Place[] = local.coords ? [local.coords] : remoteFresh && remote.items ? mergePlaces(local.places, remote.items) : local.places;
  const searching = wantsRemote && !remoteFresh;
  const offline = remoteFresh && remote.failed;

  // Address layer: debounced, cancelled on the next keystroke. State is only set from the async callback.
  useEffect(() => {
    if (!wantsRemote) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const found = await searchRemote(text, ctrl.signal);
        if (!ctrl.signal.aborted) setRemote({ q: text, items: found, failed: false });
      } catch {
        if (!ctrl.signal.aborted) setRemote({ q: text, items: null, failed: true });
      }
    }, DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [text, wantsRemote]);

  function choose(p: Place) {
    setOpen(false);
    setQ([p.label, p.detail].filter(Boolean).join(", "));
    onChoose(p);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (items[active]) return choose(items[active]);
    if (q.trim().length >= 2) {
      setOpen(false);
      onFreeText(q.trim());
    } else {
      inputRef.current?.focus();
    }
  }

  const showList = open && q.trim().length >= 2 && (items.length > 0 || searching);

  return (
    <form role="search" onSubmit={submit} className="relative w-full">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Where on Earth? An address, a place or coordinates
      </label>
      <div className="flex items-center gap-2 rounded-2xl border border-line-strong bg-space/80 p-1.5 pl-4 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-md transition-colors focus-within:border-inbound-hi sm:pl-5">
        <svg viewBox="0 0 16 16" className="size-5 shrink-0 text-fg-3" aria-hidden>
          <path d={KIND_ICON.place} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
        <input
          ref={inputRef}
          id={`${listId}-input`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && items[active] ? `${listId}-${active}` : undefined}
          aria-describedby={statusId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder="An address, a place or coordinates"
          // The global :focus-visible outline is unlayered and beats utilities; the field's box shows focus instead.
          style={{ outline: "none" }}
          className="min-w-0 flex-1 bg-transparent py-3 text-base text-fg placeholder:text-fg-3 focus:outline-none focus-visible:outline-none sm:text-lg"
        />
        <button
          type="submit"
          aria-label="Go to this place"
          className="grid size-11 shrink-0 place-items-center rounded-xl bg-inbound text-space transition-colors hover:bg-inbound-hi sm:size-12"
        >
          <svg viewBox="0 0 16 16" className="size-5" aria-hidden>
            <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <p id={statusId} className="sr-only" aria-live="polite">
        {searching ? "Searching addresses" : showList ? `${items.length} suggestions` : ""}
      </p>

      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="scroll-quiet absolute inset-x-0 bottom-full z-20 mb-2 max-h-[min(22rem,45vh)] text-left sm:top-full sm:bottom-auto sm:mt-2 sm:mb-0 overflow-y-auto rounded-xl border border-line-strong bg-panel/95 p-1.5 shadow-2xl backdrop-blur-md"
        >
          {items.map((p, i) => (
            <li
              key={`${p.label}-${p.lat}-${p.lng}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(p)}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 ${i === active ? "bg-raised" : ""}`}
            >
              <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-fg-3" aria-hidden>
                <path d={KIND_ICON[p.kind]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-fg">{p.label}</span>
                {p.detail && <span className="truncate text-sm text-fg-3">{p.detail}</span>}
              </span>
            </li>
          ))}
          {searching && <li className="px-3 py-2 text-sm text-fg-3">Searching addresses…</li>}
          {offline && !searching && <li className="px-3 py-2 text-xs text-fg-3">Address search is unavailable; showing built-in places.</li>}
        </ul>
      )}
    </form>
  );
}
