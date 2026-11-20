#!/usr/bin/env node
// Creates a new deck from a template:
//   node tools/new.mjs <name> ["Title"] [--template default] [--audience colleagues|peers|keynote|students|public|"own words"] [--length 20]
import path from 'node:path';
import { createDeck, ROOT } from './lib.mjs';
import { AUDIENCES } from '../editor/js/audiences.js';

const args = process.argv.slice(2);
const flag = f => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : null; };
const template = flag('--template') ?? 'default';
const who = flag('--audience');
const minutes = Math.round(+flag('--length')) || null; // talk length in minutes
// A preset's key (or name), or anything else as a description of the audience.
const preset = who && AUDIENCES.find(a => a.key === who.toLowerCase() || a.name.toLowerCase() === who.toLowerCase());
const audience = !who ? null : preset ? { key: preset.key } : { key: 'custom', text: who };
const [name, title] = args;
if (!name) {
  console.log(`Usage: npm run new -- <name> ["Title"] [--template default] [--audience ${AUDIENCES.map(a => a.key).join('|')}|"description"] [--length minutes]`);
  process.exit(1);
}
try {
  const dir = createDeck(name, { template, title, audience, minutes });
  console.log(`✓ Created ${path.relative(ROOT, dir)}/  — open it with: npm run dev`);
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
