// Responsive & input-capability hooks (FR-U2 overhaul): the UI adapts copy,
// affordances and target sizes to the device instead of assuming a desktop
// (hover + keyboard). Pure CSS `(pointer: coarse)` media queries handle sizing;
// these hooks cover the cases that need different JSX (hint copy, shortcut
// hints, alternate layouts like the log's card list).
import { useEffect, useState } from 'react';

/** Layout tiers in px — keep in sync with the tier table in styles.css. */
export const BREAKPOINTS = { phone: 640, tablet: 1024 } as const;

export type Breakpoint = 'phone' | 'tablet' | 'desktop';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange(); // re-sync if the query string changed since init
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** phone < 640 ≤ tablet < 1024 ≤ desktop (tiers documented in styles.css). */
export function useBreakpoint(): Breakpoint {
  const phone = useMedia(`(max-width: ${BREAKPOINTS.phone - 1}px)`);
  const tablet = useMedia(`(min-width: ${BREAKPOINTS.phone}px) and (max-width: ${BREAKPOINTS.tablet - 1}px)`);
  return phone ? 'phone' : tablet ? 'tablet' : 'desktop';
}

/** The primary pointer is a finger (phones, most tablets) — hover never
 *  available and keyboard shortcuts unusable. */
export function useIsTouch(): boolean {
  return useMedia('(pointer: coarse)');
}

/** Desktop-class device: hover-capable fine pointer. Keyboard shortcuts are
 *  *likely* available but not guaranteed (touchscreen laptops) — shortcut
 *  hints may be shown, never relied on exclusively. */
export function useHasHover(): boolean {
  return useMedia('(hover: hover) and (pointer: fine)');
}
