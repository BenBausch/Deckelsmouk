#!/usr/bin/env node
// Creates a new deck from a template: node tools/new.mjs <name> ["Title"] [--template default]
import path from 'node:path';
import { createDeck, ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const t = args.indexOf('--template');
const template = t >= 0 ? args.splice(t, 2)[1] : 'default';
const [name, title] = args;
if (!name) { console.log('Usage: npm run new -- <name> ["Title"] [--template default]'); process.exit(1); }
try {
  const dir = createDeck(name, { template, title });
  console.log(`✓ Created ${path.relative(ROOT, dir)}/  — open it with: npm run dev`);
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
