// Non-blocking prompt dialog — replaces window.prompt, which blocks the tab's
// event loop and clashes with the design system.
import { createRoot, type Root } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';

export interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  danger?: boolean;
  /** Exact string the user must type to confirm (typed deletion, FR-P1). */
  mustType?: string;
}

let host: Root | null = null;

function ensureHost(): Root {
  if (!host) {
    const el = document.createElement('div');
    el.id = 'tk-prompt-host';
    document.body.appendChild(el);
    host = createRoot(el);
  }
  return host;
}

/** Resolves with the entered string, or null when cancelled. */
export function openPrompt(opts: PromptOptions): Promise<string | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    ensureHost().render(
      <PromptModal
        opts={opts}
        onDone={(v) => {
          ensureHost().render(null);
          resolve(v);
        }}
      />
    );
  });
}

function PromptModal({ opts, onDone }: { opts: PromptOptions; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(opts.initialValue ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const ok = !opts.mustType || v === opts.mustType;
  return (
    <div className="modal-overlay" role="dialog" aria-label={opts.title} onClick={() => onDone(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{opts.title}</h3>
        {opts.message && <p className="muted" style={{ marginTop: 0 }}>{opts.message}</p>}
        <input ref={ref} className="input" value={v} placeholder={opts.placeholder ?? ''}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ok) onDone(v);
            if (e.key === 'Escape') onDone(null);
          }} />
        {!ok && <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>Type “{opts.mustType}” to confirm.</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button className={`btn ${opts.danger ? 'danger' : 'primary'}`} disabled={!ok}
            onClick={() => onDone(v)}>{opts.confirmText ?? 'OK'}</button>
        </div>
      </div>
    </div>
  );
}
