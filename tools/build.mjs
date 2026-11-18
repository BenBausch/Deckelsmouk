#!/usr/bin/env node
// Builds decks into single self-contained HTML files: dist/<name>.html
// Usage: node tools/build.mjs [deck ...]      (no arguments: every deck)
import fs from 'node:fs';
import path from 'node:path';
import { bundle, listDecks, DIST } from './lib.mjs';

const names = process.argv.slice(2).map(n => n.replace(/^decks\//, '').replace(/\/$/, ''));
const todo = names.length ? names : listDecks().map(d => d.name);
if (!todo.length) { console.log('No decks found in decks/.'); process.exit(0); }
fs.mkdirSync(DIST, { recursive: true });
let failed = 0;
for (const name of todo) {
  try {
    const { html, assets } = bundle(name, { log: m => console.log(`  ${name}: ${m}`) });
    const out = path.join(DIST, `${name}.html`);
    fs.writeFileSync(out, html);
    console.log(`✓ dist/${name}.html  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${assets} asset${assets === 1 ? '' : 's'} inlined)`);
  } catch (e) { failed++; console.error(`✗ ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
