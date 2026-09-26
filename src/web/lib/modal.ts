// Modal accessibility (audit: no modal had Escape handling or a focus trap —
// Tab escaped into background content and keyboard users lost their place).
import { useEffect, useRef } from 'react';

/**
 * Escape → onClose; Tab cycles within the dialog; focus moves in on mount and
 * returns to the previously-focused element on unmount.
 * The keydown listener is capture-phase so it beats global shortcut handlers
 * (App's number keys, TreeSidebar's N/T/Delete).
 *
 * Listeners subscribe ONCE (mount → unmount) — `onClose`/`shouldRestoreFocus`
 * are read through refs. Subscribing per-render (the callback identity changes
 * on every keystroke of a controlled input) thrashed focus and made the
 * unmount-time restore unreliable. `shouldRestoreFocus` lets callers keep the
 * focus-restore for cancels but skip it for confirms — restoring to the
 * trigger button after a confirm meant the next Enter re-opened the dialog
 * (the "Enter doesn't close the prompt" trap).
 */
export function useModalA11y(onClose?: () => void, shouldRestoreFocus: () => boolean = () => true) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const restoreRef = useRef(shouldRestoreFocus);
  useEffect(() => {
    onCloseRef.current = onClose;
    restoreRef.current = shouldRestoreFocus;
  });
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onCloseRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0]!,
        last = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (restoreRef.current()) prevFocus?.focus?.();
    };
  }, []); // subscribe once — values flow through refs
  return ref;
}
