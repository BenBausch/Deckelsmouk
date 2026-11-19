#!/usr/bin/env node
// Makes a template from a presentation: node tools/import.mjs <file.pptx|.potx|.html|.pdf|.zip> ["Template name"]
// PowerPoint files are converted directly. For HTML, PDF and .zip the template starts as a copy of the default one,
// and the printed prompt asks Claude Code to give it the original's look (or open the template in the editor).
import fs from 'node:fs';
import path from 'node:path';
import { importPresentation } from './importer.mjs';

const [file, name] = process.argv.slice(2);
if (!file) { console.log('Usage: npm run import -- <file.pptx|.potx|.html|.pdf|.zip> ["Template name"]'); process.exit(1); }
try {
  const r = importPresentation(fs.readFileSync(file), path.basename(file), { title: name });
  console.log(`✓ templates/${r.name}/ created from ${path.basename(file)}`);
  if (r.report) {
    console.log(`  ${r.report.layouts.length} layouts · fonts ${r.report.fonts.join(', ') || '(none)'} · ${r.report.images} image${r.report.images === 1 ? '' : 's'} · ${r.report.size}`);
    r.report.warnings.forEach(w => console.log(`  ! ${w}`));
  }
  if (r.prompt) console.log(`\nNext, ask Claude Code (or open the template in the editor, which does this for you):\n\n${r.prompt}\n`);
  console.log(`Open it: npm run dev, then http://localhost:4800/?template=${r.name}`);
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
