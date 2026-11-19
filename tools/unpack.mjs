#!/usr/bin/env node
// Turns a built single-file deck back into editable source: node tools/unpack.mjs dist/talk.html talk
// (Embedded assets become decks/<name>/assets/asset-N.<ext>.)
import { unpack } from './lib.mjs';

const [file, name] = process.argv.slice(2);
if (!file || !name) { console.log('Usage: npm run unpack -- <file.html> <deck-name>'); process.exit(1); }
try {
  const { assets, name: used } = unpack(file, name);
  console.log(`✓ decks/${used}/ created (${assets} asset${assets === 1 ? '' : 's'} extracted)`);
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
