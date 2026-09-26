// CSP posture (audit #5). The app has no HTML-injection sink today, so the
// policy is defence-in-depth for the day someone adds one. This locks BOTH
// halves of the story:
//   - the invariant: nothing writes HTML from a string,
//   - the containment: `style-src-elem 'self'` refuses an injected <style>
//     block even though inline style attributes stay allowed (React needs them).
// The remaining gap is documented rather than silently forgotten: dropping
// 'unsafe-inline' entirely means extracting ~200 `style={{…}}` sites.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB_DIR = 'src/web';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sources = walk(WEB_DIR)
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));

describe('no HTML-injection sinks (CSP precondition)', () => {
  it('finds no dangerouslySetInnerHTML / innerHTML / outerHTML in the SPA', () => {
    const offenders = sources.filter((s) =>
      /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/.test(s.text),
    );
    expect(offenders.map((s) => s.file)).toEqual([]);
  });

  it('still renders text through JSX children (not string HTML)', () => {
    // a positive control: the chat body renders {m.body} as a child. Whitespace
    // between the tag and the expression is Prettier's business, so match loosely.
    const chat = sources.find((s) => s.file.endsWith('ChatDock.tsx'))!;
    expect(chat.text).toMatch(/className="msg-body"[\s\S]*?\{m\.body\}[\s\S]*?<\/span>/);
  });
});

describe('CSP header', () => {
  const csp = readFileSync('src/worker/middleware.ts', 'utf8');

  it("declares style-src-elem 'self' (blocks an injected <style> block)", () => {
    expect(csp).toContain('"style-src-elem \'self\'"');
  });

  it("keeps 'unsafe-inline' for style attributes only, with the trade-off documented", () => {
    expect(csp).toContain("\"style-src 'self' 'unsafe-inline'\"");
    // the comment must keep naming the real blocker (200+ inline styles)
    expect(csp).toMatch(/audit #5/);
  });

  it('keeps the other strict directives', () => {
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
});
