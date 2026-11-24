#!/usr/bin/env node
// Renders the start page's watercolour art into the pictures the page shows. The sources are editor/art/*.svg; their
// filters (turbulence, displacement) are slow to draw, and Firefox draws them again while the page moves, which makes
// the start page stutter. So each SVG is drawn once here, at twice the size the page shows it, into a .webp next to it.
// Run after changing an SVG: node tools/art.mjs [name…]   (uses an installed browser, like the exports: render.mjs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';
import { openBrowser } from './render.mjs';

const ART = path.join(ROOT, 'editor', 'art');
// Name: [width, height] in pixels, WebP quality. walk is the painting (1.5× its widest, soft enough), paper the
// background tile (shown at this size: it is only grain); wash, wash-button, bloom and stroke are shapes used as CSS
// masks; dabs is the memo's colours.
const SIZES = {
  walk: [2400, 540, 0.8], paper: [360, 360, 0.8], dabs: [440, 80, 0.88],
  wash: [800, 400, 0.85], 'wash-button': [600, 180, 0.88], bloom: [400, 400, 0.88], stroke: [600, 60, 0.88],
};

const only = process.argv.slice(2);
const names = only.length ? only : Object.keys(SIZES);
for (const n of names) if (!SIZES[n]) { console.error(`Unknown picture "${n}". Known: ${Object.keys(SIZES).join(', ')}`); process.exit(1); }

const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deckelsmouk-art-')), 'art.html');
fs.writeFileSync(stub, '<!doctype html><meta charset="utf-8"><title>art</title>');
const b = await openBrowser();
try {
  await b.goto(pathToFileURL(stub).href);
  for (const name of names) {
    const [w, h, quality] = SIZES[name];
    // The SVG gets an explicit size so it is drawn as vectors at that size, not scaled up from a default one.
    const svg = fs.readFileSync(path.join(ART, `${name}.svg`), 'utf8')
      .replace(/<svg\b[^>]*>/, tag => tag.replace(/\s(?:width|height)="[^"]*"/g, '').replace('<svg', `<svg width="${w}" height="${h}"`));
    const data = await b.json(`(async () => {
      const url = URL.createObjectURL(new Blob([${JSON.stringify(svg)}], { type: 'image/svg+xml' }));
      const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
      c.getContext('2d').drawImage(img, 0, 0, ${w}, ${h});
      URL.revokeObjectURL(url);
      return c.toDataURL('image/webp', ${quality});
    })()`);
    if (!data.startsWith('data:image/webp')) throw new Error('This browser cannot write WebP pictures; try another one (DECK_BROWSER=…).');
    const buf = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
    fs.writeFileSync(path.join(ART, `${name}.webp`), buf);
    console.log(`editor/art/${name}.webp  ${w}×${h}  ${Math.round(buf.length / 1024)} KB`);
  }
} finally {
  await b.close();
  fs.rmSync(path.dirname(stub), { recursive: true, force: true });
}
