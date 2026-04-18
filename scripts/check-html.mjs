// Lightweight HTML sanity check.
// Verifies every [data-role="..."] referenced in app.js is present in
// index.html, catching typos without spinning up a browser.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
const js   = readFileSync(resolve(root, 'app.js'), 'utf8')

// References: CSS-selector form [data-role="..."] used in querySelector calls.
// Definitions: attribute form data-role="..." in static HTML or JS templates.
const referenced = new Set(
  [...js.matchAll(/\[data-role="([^"]+)"\]/g)].map(m => m[1])
)
const defined = new Set([
  ...[...html.matchAll(/data-role="([^"]+)"/g)].map(m => m[1]),
  ...[...js.matchAll(/data-role="([^"]+)"/g)].map(m => m[1])
])

const missing = [...referenced].filter(r => !defined.has(r))
if (missing.length) {
  console.error('✗ app.js references data-role targets missing from index.html:')
  for (const m of missing) console.error('  -', m)
  process.exit(1)
}
console.log(`✓ ${referenced.size} data-role references resolve (of ${defined.size} defined in HTML)`)
