// CSP posture (audit #5, F13). The app has no HTML-injection sink today, so the
// policy is defence-in-depth for the day someone adds one. This locks BOTH
// halves of the story:
//   - the invariant: nothing writes HTML from a string,
//   - the containment: no 'unsafe-inline' anywhere — style-src 'self' +
//     style-src-attr 'none' + style-src-elem 'self' refuse every inline style
//     vector (attributes, <style> blocks). React's style={{…}} prop mutates
//     CSSOM, which CSP does not govern, so the flip was evidence-first: the
//     tightened policy shipped as Report-Only and the whole SPA was
//     browser-driven with zero violation reports before the enforced header
//     dropped the exception.
// A new inline-style vector (setAttribute('style', …), a style= attribute, a
// <style> block) must NOT land together with a policy weakening — these
// assertions fail first.
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

  it('finds no style-attribute sinks (the CSP-unsafe inline-style vectors)', () => {
    // React's style={{…}} prop is CSSOM (CSP-exempt); these are the vectors
    // 'unsafe-inline' would have been needed for:
    const offenders = sources.filter((s) => /setAttribute\(\s*['"`]style|<style[ >]/.test(s.text));
    expect(offenders.map((s) => s.file)).toEqual([]);
  });
});

describe('CSP header', () => {
  const csp = readFileSync('src/worker/middleware.ts', 'utf8');

  it("declares style-src-elem 'self' (blocks an injected <style> block)", () => {
    expect(csp).toContain('"style-src-elem \'self\'"');
  });

  it("declares style-src-attr 'none' (blocks style attributes outright, F13)", () => {
    expect(csp).toContain('"style-src-attr \'none\'"');
  });

  it("carries NO 'unsafe-inline' in the policy (F13: flipped after the zero-violation drive)", () => {
    // the POLICY strings — the word may (and must) still appear in the
    // comment documenting why it was dropped
    expect(csp).not.toContain("\"style-src 'self' 'unsafe-inline'\"");
    expect(csp).toContain('"style-src \'self\'",');
    expect(csp).not.toContain("'unsafe-inline' ?");
    // the comment must keep the reasoning (CSSOM vs markup, evidence-first)
    expect(csp).toMatch(/F13/);
    expect(csp).toMatch(/CSSOM/);
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
