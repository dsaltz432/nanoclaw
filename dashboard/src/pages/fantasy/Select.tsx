import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Custom choice controls for the Fantasy tab, replacing the native <select>.
 *
 * Two forms:
 *   - `Select`    — a trigger button and a listbox popover. For lists that are
 *                   long, dynamic, or carry a hint per option.
 *   - `Segmented` — a pill group with one filled segment. For two-to-four
 *                   short, fixed choices where seeing every option at once is
 *                   worth the horizontal space.
 *
 * Both are controlled: `value` in, `onChange(value)` out, always a string, so
 * the call sites keep the exact state and coercion they had with the native
 * element (numbers are `Number(v)`'d by the caller, as before).
 *
 * The popover is portalled to <body> and positioned `fixed`, so a card header
 * or an `overflow-x-auto` table wrapper cannot clip it. It sits at z-50 —
 * above cards and the NewsPeek panel (z-30), below the PlayerDossier modal
 * (z-[1000]). It flips above the trigger when the space below it is short.
 */

export type SelectOption = { value: string; label: string; hint?: string };

type CommonProps = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  "aria-label": string;
  /** Muted prefix inside the trigger, e.g. label="claims" → "claims: 7 days". */
  label?: string;
  size?: "sm" | "md";
  className?: string;
  tone?: "default" | "accent";
};

const CHEVRON = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CHECK = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
    <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Estimated popover height used to decide above/below before it is measured. */
const FLIP_ESTIMATE = 240;
const GAP = 4;
const MAX_LIST_HEIGHT = 288;

export function Select({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  label,
  size = "md",
  className = "",
  tone = "default",
}: CommonProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; above: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ buf: string; at: number }>({ buf: "", at: 0 });
  const id = useId();

  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIdx];

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const listH = Math.min(MAX_LIST_HEIGHT, listRef.current?.offsetHeight ?? FLIP_ESTIMATE);
    const below = window.innerHeight - r.bottom - GAP;
    const above = r.top - GAP;
    const flip = below < listH && above > below;
    // At least as wide as the trigger; a hint or long label may widen it, but
    // never past the viewport edge.
    const width = Math.max(r.width, 160);
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
    setPos({
      top: flip ? r.top - GAP : r.bottom + GAP,
      left,
      width,
      above: flip,
    });
  }, []);

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      setPos(null);
      if (refocus) triggerRef.current?.focus();
    },
    [],
  );

  const openList = (startAt?: number) => {
    setActive(startAt ?? selectedIdx);
    setOpen(true);
  };

  // Position once the list exists (so its real height can be measured), then
  // hand it focus so arrow keys work without a second click.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    listRef.current?.focus({ preventScroll: true });
  }, [open, place]);

  // Keep the active option in view as the keyboard moves it.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // Outside click / tap, scroll and resize all dismiss. `pointerdown` rather
  // than `click` so a tap on another control closes this one before that
  // control reacts, instead of needing two taps.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, close, place]);

  const pick = (idx: number) => {
    const o = options[idx];
    if (!o) return;
    if (o.value !== value) onChange(o.value);
    close();
  };

  const move = (delta: number) => {
    if (!options.length) return;
    setActive((a) => (a + delta + options.length) % options.length);
  };

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList(e.key === "ArrowUp" ? Math.max(0, selectedIdx) : selectedIdx);
    }
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        pick(active);
        return;
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "Tab":
        // The list is portalled to the end of <body>, so the browser's default
        // Tab from it lands nowhere useful. Put focus back on the trigger
        // first (synchronously) and let the default action move on from there.
        close();
        return;
    }
    // Type-ahead: letters typed within half a second accumulate into a prefix.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const ta = typeahead.current;
      ta.buf = now - ta.at < 500 ? ta.buf + e.key.toLowerCase() : e.key.toLowerCase();
      ta.at = now;
      const from = ta.buf.length === 1 ? active + 1 : active;
      for (let i = 0; i < options.length; i++) {
        const idx = (from + i) % options.length;
        if (options[idx]?.label.toLowerCase().startsWith(ta.buf)) {
          setActive(idx);
          break;
        }
      }
    }
  };

  const sizeCls =
    size === "sm"
      ? "px-2 py-1 text-xs gap-1.5"
      : tone === "accent"
        ? "px-3 py-2.5 text-sm font-medium gap-2"
        : "px-2.5 py-1.5 text-xs gap-1.5";
  const toneCls =
    tone === "accent"
      ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200 hover:border-indigo-400/60 hover:bg-indigo-500/15"
      : "border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-700 hover:text-gray-200";
  const labelCls = tone === "accent" ? "text-indigo-300/70" : "text-gray-500";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onTriggerKey}
        className={`inline-flex items-center justify-between ${tone === "accent" ? "rounded-lg" : "rounded-md"} border text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
          open ? (tone === "accent" ? "border-indigo-400/60" : "border-gray-700 text-gray-200") : ""
        } ${sizeCls} ${toneCls} ${className}`}
      >
        <span className="min-w-0 truncate">
          {label && <span className={labelCls}>{label}: </span>}
          {selected?.label ?? ""}
        </span>
        <span className={`transition-transform ${open ? "rotate-180" : ""} ${tone === "accent" ? "text-indigo-300/80" : "text-gray-500"}`}>
          {CHEVRON}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-activedescendant={`${id}-opt-${active}`}
            onKeyDown={onListKey}
            className="ff-listbox fixed z-50 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-1 shadow-xl shadow-black/40 focus:outline-none"
            style={{
              top: pos ? (pos.above ? undefined : pos.top) : -9999,
              bottom: pos?.above ? window.innerHeight - pos.top : undefined,
              left: pos?.left ?? 0,
              minWidth: pos?.width ?? 0,
              maxWidth: `calc(100vw - 16px)`,
              maxHeight: MAX_LIST_HEIGHT,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {options.map((o, i) => {
              const isSel = o.value === value;
              const isActive = i === active;
              return (
                <div
                  key={o.value}
                  id={`${id}-opt-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(i)}
                  className={`flex min-h-[40px] cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                    isActive ? "bg-gray-800 text-gray-100" : "text-gray-300"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block ${isSel ? "font-medium text-gray-100" : ""}`}>{o.label}</span>
                    {o.hint && <span className="block text-[11px] leading-snug text-gray-500">{o.hint}</span>}
                  </span>
                  <span className={`w-3 ${isSel ? "text-indigo-400" : "text-transparent"}`}>{CHECK}</span>
                </div>
              );
            })}
            {options.length === 0 && <div className="px-2.5 py-2 text-xs text-gray-600">No options</div>}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Pill group. One segment is filled; the rest are quiet. Wraps on a narrow
 * screen rather than overflowing — a two-line group beats a clipped one.
 */
export function Segmented({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  label,
  size = "md",
  className = "",
  tone = "default",
}: CommonProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next == null || !options.length) return;
    e.preventDefault();
    const o = options[next];
    if (!o) return;
    if (o.value !== value) onChange(o.value);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-idx="${next}"]`)?.focus();
  };

  const padCls = size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs";
  const onCls =
    tone === "accent"
      ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-inset ring-indigo-500/40"
      : "bg-gray-800 text-gray-100 ring-1 ring-inset ring-gray-700";
  const offCls = "text-gray-500 hover:text-gray-300";

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      className={`inline-flex flex-wrap items-center gap-0.5 rounded-md border border-gray-800 bg-gray-900 p-0.5 ${className}`}
    >
      {label && <span className="px-1.5 text-[11px] text-gray-500">{label}</span>}
      {options.map((o, i) => {
        const on = i === idx;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-idx={i}
            tabIndex={on ? 0 : -1}
            title={o.hint}
            onClick={() => {
              if (o.value !== value) onChange(o.value);
            }}
            className={`whitespace-nowrap rounded font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${padCls} ${
              on ? onCls : offCls
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
