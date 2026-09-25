import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * A narrow row label that auto-scrolls its full text while hovered on a
 * fine-pointer device. Touch devices keep the existing two-line clamp, and
 * reduced-motion users can still scroll the label manually.
 */
export default function HoverScrollText({ children, className = '', title }: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const start = () => {
      el.classList.remove('is-scrolling');
      if (!finePointer.matches || reducedMotion.matches || el.scrollWidth <= el.clientWidth + 1) return;
      el.style.setProperty('--hover-scroll-distance', `${el.scrollWidth - el.clientWidth}px`);
      // Restart the animation when the pointer returns to an already-hovered row.
      void el.offsetWidth;
      el.classList.add('is-scrolling');
    };
    const stop = () => {
      el.classList.remove('is-scrolling');
    };

    el.addEventListener('mouseenter', start);
    el.addEventListener('mouseleave', stop);
    return () => {
      el.removeEventListener('mouseenter', start);
      el.removeEventListener('mouseleave', stop);
      stop();
    };
  }, []);

  return (
    <span ref={ref} className={`hover-scroll ${className}`} title={title}>
      <span className="hover-scroll-content">{children}</span>
    </span>
  );
}
