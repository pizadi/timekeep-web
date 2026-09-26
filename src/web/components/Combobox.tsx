// Combobox — styled replacement for native <datalist> suggestion boxes (which
// cannot be themed). Input + filtered, grouped dropdown with full keyboard
// support (↑/↓/Enter/Esc/Tab), ARIA combobox semantics, and project-color chips.
// The list is viewport-positioned (position: fixed off the input's rect) so a
// modal's scroll container can never clip it; it flips upward near the screen
// bottom.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface ComboboxOption {
  value: string;
  label: string;
  color?: string; // optional leading chip color
  hint?: string; // optional right-aligned muted text
}
export interface ComboboxGroup {
  label?: string; // header rendered above the group's first option
  options: ComboboxOption[];
}

interface FlatItem {
  groupLabel?: string;
  option: ComboboxOption;
  index: number;
}

export default function Combobox({
  text,
  onTextChange,
  onPick,
  groups,
  placeholder,
  ariaLabel,
  onBlur,
}: {
  text: string;
  onTextChange: (v: string) => void;
  /** Called with the picked option's value (selection is explicit — typed text alone never picks). */
  onPick: (value: string) => void;
  groups: ComboboxGroup[];
  placeholder?: string;
  ariaLabel: string;
  /** Blur commit hook (e.g. Settings' save-on-blur fields). */
  onBlur?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; width: number; top: number; above: boolean } | null>(null);

  // filter + flatten (group header travels on the group's first hit)
  const items = useMemo<FlatItem[]>(() => {
    const needle = text.trim().toLowerCase();
    const out: FlatItem[] = [];
    for (const g of groups) {
      const hits = g.options.filter((o) => !needle || o.label.toLowerCase().includes(needle));
      if (hits.length === 0) continue;
      hits.forEach((o, i) => out.push({ groupLabel: i === 0 ? g.label : undefined, option: o, index: out.length }));
    }
    return out;
  }, [groups, text]);

  const place = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const LIST_H = 240; // keep in sync with .combobox-list max-height
    const above = window.innerHeight - r.bottom < LIST_H / 2 && r.top > LIST_H;
    setRect({ left: r.left, width: r.width, top: above ? r.top : r.bottom, above });
  };

  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    place();
    // capture: also catches scrolls of inner containers (the settings modal)
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // reset/normalize the highlight when the list content or visibility changes
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);
  useEffect(() => {
    if (open && active >= 0) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // click-outside closes (the list itself is inside the wrapper ref)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  function commit(item: FlatItem): void {
    setOpen(false);
    onPick(item.option.value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      if (items.length) commit(items[Math.min(Math.max(active, 0), items.length - 1)]!);
      else setOpen(false);
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  }

  return (
    <div className="combobox" ref={wrapRef}>
      <input
        ref={inputRef}
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? `${listId}-list` : undefined}
        aria-activedescendant={
          open && items.length ? `${listId}-opt-${Math.min(Math.max(active, 0), items.length - 1)}` : undefined
        }
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          onTextChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          onBlur?.();
        }}
        onKeyDown={onKeyDown}
      />
      {open && rect && (
        <div
          className="combobox-list"
          id={`${listId}-list`}
          role="listbox"
          aria-label={ariaLabel}
          // preventDefault on mousedown keeps focus in the input — the option's
          // click still fires, and the input never blurs mid-pick
          onMouseDown={(e) => e.preventDefault()}
          style={{
            left: rect.left,
            width: Math.max(rect.width, 220),
            ...(rect.above ? { bottom: window.innerHeight - rect.top } : { top: rect.top }),
          }}
        >
          {items.map((it) => (
            <div key={`${it.index}-${it.option.value}`}>
              {it.groupLabel && <div className="combobox-group-label">{it.groupLabel}</div>}
              <div
                ref={it.index === active ? activeRef : undefined}
                id={`${listId}-opt-${it.index}`}
                role="option"
                aria-selected={it.index === active}
                title={it.option.label}
                className={`combobox-opt${it.index === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(it.index)}
                onClick={() => commit(it)}
              >
                {it.option.color && <span className="chip" style={{ background: it.option.color }} />}
                <span className="grow">{it.option.label}</span>
                {it.option.hint && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {it.option.hint}
                  </span>
                )}
              </div>
            </div>
          ))}
          {items.length === 0 && <div className="combobox-empty">No matches</div>}
        </div>
      )}
    </div>
  );
}
