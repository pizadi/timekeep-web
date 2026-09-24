// Graphical dropdown — styled replacement for native <select>: options render
// icons / project color chips, the listbox is keyboard-navigable
// (↑/↓/Home/End + Enter, Esc closes) with focus kept on the trigger
// (aria-activedescendant), and it closes on outside pointerdown. The menu is
// fixed-position on open so it can overflow modals/toolbars like Combobox does.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
  icon?: ReactNode;   // glyph or color chip rendered left of the label
  hint?: string;      // muted secondary text on the right
}

export default function Dropdown({ value, onChange, options, ariaLabel, style, disabled }: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  ariaLabel: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const current = options.find((o) => o.value === value) ?? options[0];

  // close on outside pointerdown (capture — the menu may overflow containers)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // highlight the current value whenever the menu opens
  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit(o: DropdownOption | undefined) {
    if (!o) return;
    setOpen(false);
    btnRef.current?.focus();
    if (o.value !== value) onChange(o.value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
      return; // Enter/Space on a closed trigger = native button click → toggles open
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); commit(options[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btnRef.current?.focus(); }
  }

  return (
    <div ref={rootRef} className="dd" style={style}>
      <button type="button" ref={btnRef} className="input dd-trigger" aria-haspopup="listbox"
        aria-expanded={open} aria-label={ariaLabel} disabled={disabled}
        title={current?.label}
        onClick={() => setOpen((o) => !o)} onKeyDown={onKeyDown}>
        {current?.icon && <span className="dd-icon">{current.icon}</span>}
        <span className="dd-label">{current?.label ?? '—'}</span>
        <span className="dd-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="dd-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((o, i) => (
            <div key={o.value} role="option" id={`dd-opt-${i}`}
              aria-selected={o.value === value}
              title={o.label}
              className={`dd-item${i === active ? ' active' : ''}${o.value === value ? ' selected' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(o)}>
              {o.icon && <span className="dd-icon">{o.icon}</span>}
              <span className="dd-label">{o.label}</span>
              {o.hint && <span className="dd-hint">{o.hint}</span>}
              {o.value === value && <span className="dd-check" aria-hidden>✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Project color chip used as a dropdown icon. */
export function ColorChip({ color }: { color: string }) {
  return <span className="chip" style={{ background: color, width: 12, height: 12, borderRadius: 3 }} aria-hidden />;
}
