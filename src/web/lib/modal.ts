// Modal accessibility (audit: no modal had Escape handling or a focus trap —
// Tab escaped into background content and keyboard users lost their place).
import { useEffect, useRef } from 'react';

/**
 * Escape → onClose; Tab cycles within the dialog; focus moves in on mount and
 * returns to the previously-focused element on unmount.
 * The keydown listener is capture-phase so it beats global shortcut handlers
 * (App's number keys, TreeSidebar's N/T/Delete).
 */
export function useModalA11y(onClose?: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    )).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0]!, last = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
    };
  }, [onClose]);
  return ref;
}
