import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'public');
const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
const css = readFileSync(join(PUBLIC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({
  selectors: selector.split(',').map((s) => s.trim()),
  body,
}));

// An author rule such as ".paste { display: flex }" beats the browser's
// [hidden] { display: none }, so the element stays on screen and the layout
// jumps when it is finally revealed or collapsed. Every hidden-able element
// whose class or id sets display needs a matching [hidden] rule.
test('elements that start hidden are not kept on screen by a display rule', () => {
  const hiddenTags = [...html.matchAll(/<[a-z0-9]+\s[^>]*\bhidden\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(hiddenTags.length > 0);

  for (const tag of hiddenTags) {
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    const classes = (tag.match(/\bclass="([^"]+)"/)?.[1] || '').split(/\s+/).filter(Boolean);
    const hooks = [...(id ? ['#' + id] : []), ...classes.map((c) => '.' + c)];

    for (const hook of hooks) {
      const sets = (selector) => selector === hook || selector.endsWith(' ' + hook);
      const overrides = rules.some((r) => r.selectors.some(sets) && /(^|;|\s)display\s*:/.test(r.body));
      if (!overrides) continue;

      const handled = rules.some((r) => r.selectors.some((s) => s === hook + '[hidden]' || s.endsWith(' ' + hook + '[hidden]'))
        && /display\s*:\s*none|visibility\s*:\s*hidden/.test(r.body));
      assert.ok(handled, hook + ' sets display but has no ' + hook + '[hidden] rule that hides it');
    }
  }
});
