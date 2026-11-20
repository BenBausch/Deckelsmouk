#!/usr/bin/env node
// Exports a deck: html (one self-contained file with every animation and transition), pdf (one page per slide, final
// state), pptx (PowerPoint: editable text boxes, pictures for everything else, speaker notes) or odp (the pptx
// converted by LibreOffice). PDF and PowerPoint render the deck in a browser that is already installed (render.mjs).
// Usage: node tools/export.mjs <deck> [html|pdf|pptx|odp]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DIST, deckDir, bundle } from './lib.mjs';
import { openBrowser } from './render.mjs';
import { writePptx } from './pptx-write.mjs';

export const FORMATS = { html: 'HTML', pdf: 'PDF', pptx: 'PowerPoint', odp: 'OpenDocument (LibreOffice)' };

/** Exports decks/<name>/ to dist/<name>.<format>. Returns { file, bytes, warnings }. */
export async function exportDeck(name, format = 'html', { log = () => {} } = {}) {
  const dir = deckDir(name);
  if (!fs.existsSync(path.join(dir, 'deck.html'))) throw new Error(`No deck "${name}"`);
  if (!FORMATS[format]) throw new Error(`Unknown format "${format}" (html, pdf, pptx or odp)`);
  fs.mkdirSync(DIST, { recursive: true });
  const file = path.join(DIST, `${name}.${format}`);
  const warnings = [];
  if (format === 'html') fs.writeFileSync(file, bundle(name, { log }).html);
  else if (format === 'pdf') fs.writeFileSync(file, await toPdf(dir));
  else if (format === 'pptx') fs.writeFileSync(file, await toPptx(dir, warnings, log));
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckelsmouk-odp-'));
    try {
      const pptx = path.join(tmp, `${name}.pptx`);
      fs.writeFileSync(pptx, await toPptx(dir, warnings, log));
      await libreOffice(pptx, 'odp', tmp);
      fs.copyFileSync(path.join(tmp, `${name}.odp`), file);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { file, bytes: fs.statSync(file).size, warnings };
}

// The deck in print mode: every slide in its final state, stacked; waits for fonts and pictures.
const pageUrl = dir => `${pathToFileURL(path.join(dir, 'deck.html')).href}?print`;
const READY = `Promise.all([document.fonts.ready, ...[...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))]).then(() => document.querySelectorAll('.stage > .slide').length)`;

async function toPdf(dir) {
  const b = await openBrowser();
  try { await b.goto(pageUrl(dir)); await b.json(READY); return await b.pdf(); }
  finally { await b.close(); }
}

/* ── PowerPoint ── */

// Runs in the page. Describes every slide as a background, pictures and text boxes, and installs window.__xp to show
// what each capture needs. Text blocks become editable text; anything else that draws (backgrounds, borders, shapes,
// pictures, SVG, canvas) is captured as a picture, with the text left out.
function analyzePage() {
  const style = document.createElement('style');
  style.textContent = `.xp-hide, .xp-hide * { visibility: hidden !important; }
    .xp-ink, .xp-ink * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; }
    .xp-ink::before, .xp-ink::after, .xp-ink *::before, .xp-ink *::after { visibility: hidden !important; }`;
  document.head.append(style);
  const MEDIA = 'img,svg,canvas,video,iframe,object,embed,picture';
  const KEYWORD = /^(-apple-system|system-ui|blinkmacsystemfont|ui-[\w-]+|sans-serif|serif|monospace|cursive|fantasy|inherit|initial|var\()$/i;
  const hex = c => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c || ''); return m ? { hex: [m[1], m[2], m[3]].map(v => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase(), alpha: m[4] === undefined ? 1 : +m[4] } : null; };
  const firstFont = f => (f || '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).find(s => s && !KEYWORD.test(s)) || 'Arial';
  const textClip = cs => cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text';
  const hidden = cs => cs.display === 'none' || cs.visibility === 'hidden';
  const isBlock = cs => /^(block|list-item|flex|grid|table|flow-root)$/.test(cs.display);
  const transparent = c => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);

  // Does anything in this object draw besides text?
  const draws = root => {
    for (const e of [root, ...root.querySelectorAll('*')]) {
      if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
      const cs = getComputedStyle(e);
      if (hidden(cs) || +cs.opacity === 0) continue;
      if (e.matches(MEDIA)) return true;
      if (!textClip(cs) && (cs.backgroundImage !== 'none' || !transparent(cs.backgroundColor))) return true;
      const bw = ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(cs[`border${s}Width`]) > 0 && !transparent(cs[`border${s}Color`]) && cs[`border${s}Style`] !== 'none');
      if (bw || cs.boxShadow !== 'none' || (cs.filter && cs.filter !== 'none')) return true;
      if (!e.matches('li')) for (const p of ['::before', '::after']) {
        const ps = getComputedStyle(e, p);
        if (ps.content && ps.content !== 'none' && ps.content !== 'normal' && (ps.backgroundImage !== 'none' || !transparent(ps.backgroundColor) || ps.content.replace(/["']/g, '').trim())) return true;
      }
    }
    return false;
  };

  // Elements that hold text directly (or lists of such), outside SVG and media.
  const textBlocks = root => {
    const out = [];
    const walk = el => {
      if (el.matches(MEDIA) || el.closest('svg')) return;
      const cs = getComputedStyle(el);
      if (hidden(cs) || +cs.opacity === 0) return;
      const kids = [...el.children];
      if ((el.tagName === 'UL' || el.tagName === 'OL') && kids.length && kids.every(k => k.tagName === 'LI')) { if (el.textContent.trim()) out.push(el); return; }
      if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) { out.push(el); return; }
      kids.forEach(walk);
    };
    walk(root);
    return out;
  };

  const runStyle = el => {
    const cs = getComputedStyle(el);
    let c = hex(cs.webkitTextFillColor && !transparent(cs.webkitTextFillColor) ? cs.webkitTextFillColor : cs.color);
    if (!c || c.alpha === 0) { // gradient text: its first colour
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (textClip(s)) { c = hex((/rgba?\([^)]*\)/.exec(s.backgroundImage) || [])[0]) || c; break; }
      }
    }
    return {
      font: firstFont(cs.fontFamily), size: parseFloat(cs.fontSize), bold: parseInt(cs.fontWeight, 10) >= 600, italic: cs.fontStyle !== 'normal',
      underline: (cs.textDecorationLine || '').includes('underline'), color: c?.hex || '000000', alpha: c ? c.alpha : 1,
      spacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0, transform: cs.textTransform,
    };
  };

  const paragraphsOf = (block, slideRect) => {
    const items = block.tagName === 'UL' || block.tagName === 'OL' ? [...block.children] : [block];
    const paras = [];
    for (const item of items) {
      let p = null;
      const start = el => { p = { el, runs: [] }; paras.push(p); };
      start(item);
      const walk = node => {
        for (const n of node.childNodes) {
          if (n.nodeType === 3) { if (n.textContent) p.runs.push({ text: n.textContent, ...runStyle(node) }); continue; }
          if (n.nodeType !== 1 || n.matches(MEDIA + ',.notes')) continue;
          if (n.tagName === 'BR') { p.runs.push({ br: true, size: parseFloat(getComputedStyle(node).fontSize) }); continue; }
          const cs = getComputedStyle(n);
          if (hidden(cs)) continue;
          if (isBlock(cs)) { start(n); walk(n); start(node); } else walk(n);
        }
      };
      walk(item);
    }
    let prev = null;
    return paras.map(p => {
      // Collapse white space like CSS; trim the paragraph's ends.
      const runs = [];
      for (const r of p.runs) {
        if (r.br) { runs.push(r); continue; }
        let t = r.text.replace(/\s+/g, ' ');
        if (r.transform === 'uppercase') t = t.toUpperCase(); else if (r.transform === 'lowercase') t = t.toLowerCase();
        const last = runs.filter(x => !x.br).at(-1);
        if (last && /\s$/.test(last.text) && t.startsWith(' ')) t = t.slice(1);
        if (t) runs.push({ ...r, text: t });
      }
      while (runs.length && !runs[0].br && !(runs[0].text = runs[0].text.replace(/^\s+/, ''))) runs.shift();
      while (runs.length && !runs.at(-1).br && !(runs.at(-1).text = runs.at(-1).text.replace(/\s+$/, ''))) runs.pop();
      if (!runs.some(r => !r.br)) return null;
      const cs = getComputedStyle(p.el), size = parseFloat(cs.fontSize);
      const r = p.el.getBoundingClientRect();
      const para = {
        align: { center: 'ctr', right: 'r', end: 'r', justify: 'just' }[cs.textAlign] || 'l',
        lineHeight: cs.lineHeight === 'normal' ? size * 1.2 : parseFloat(cs.lineHeight),
        spaceBefore: prev ? Math.max(0, r.top - prev.bottom) : 0,
        bullet: null, indent: 0, runs: runs.map(({ transform, ...x }) => x),
      };
      prev = r;
      if (p.el.tagName === 'LI') {
        const b = getComputedStyle(p.el, '::before');
        const content = (b.content || 'none').replace(/^["']|["']$/g, '');
        if (p.el.parentElement.tagName === 'OL' && cs.listStyleType !== 'none') para.bullet = { num: true };
        else if (b.content && b.content !== 'none' && b.content !== 'normal') {
          const dot = !content.trim();
          const c = hex(dot ? b.backgroundColor : b.color);
          para.bullet = { char: dot ? '•' : content.trim().slice(0, 2), color: c && c.alpha > 0 ? c.hex : null };
          para.indent = (parseFloat(b.width) || size * 1.2) + (parseFloat(b.marginRight) || 0);
        } else if (cs.listStyleType !== 'none') { para.bullet = { char: '•', color: null }; para.indent = size * 1.2; }
        if (para.bullet && !para.indent) para.indent = size * 1.2;
      }
      return para;
    }).filter(Boolean);
  };

  // Blur and shadows draw outside an element's box: how far.
  const spill = el => {
    const cs = getComputedStyle(el);
    let g = 0;
    const blur = /blur\(([\d.]+)px\)/.exec(cs.filter || '');
    if (blur) g = +blur[1] * 2.5;
    if (cs.boxShadow && cs.boxShadow !== 'none') for (const s of cs.boxShadow.split(/,(?![^(]*\))/)) {
      const n = (s.match(/-?[\d.]+px/g) || []).map(parseFloat);
      if (n.length >= 2 && !/inset/.test(s)) g = Math.max(g, Math.max(Math.abs(n[0]), Math.abs(n[1])) + (n[2] || 0) * 1.5 + Math.max(0, n[3] || 0));
    }
    return g;
  };

  const slides = [...document.querySelectorAll('.stage > .slide')];
  const data = slides.map((slide, si) => {
    const sr = slide.getBoundingClientRect();
    const rel = r => ({ x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height });
    const clip = r => { const x = Math.max(r.left, sr.left), y = Math.max(r.top, sr.top); return { x, y, w: Math.min(r.right, sr.right) - x, h: Math.min(r.bottom, sr.bottom) - y }; };
    const scs = getComputedStyle(slide);
    const solid = scs.backgroundImage === 'none' ? hex(scs.backgroundColor) : null;
    const objects = [...slide.children].filter(el => !el.matches('.notes, script, style, template'));
    objects.forEach((el, i) => { el.dataset.xp = i; });
    const items = [];
    objects.forEach((el, i) => {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (hidden(cs) || +cs.opacity === 0 || box.width < 0.5 || box.height < 0.5) return;
      const g = spill(el);
      const r = { left: box.left - g, top: box.top - g, right: box.right + g, bottom: box.bottom + g };
      const c = clip(r);
      if (c.w <= 0 || c.h <= 0) return;
      const blocks = textBlocks(el);
      blocks.forEach(b => b.classList.add('xp-text'));
      if (draws(el) || !blocks.length) items.push({ type: 'picture', object: i, box: { x: c.x - sr.left, y: c.y - sr.top, w: c.w, h: c.h }, name: el.dataset.el || el.tagName.toLowerCase() });
      for (const b of blocks) {
        const bcs = getComputedStyle(b);
        const flexCol = bcs.display === 'flex' && bcs.flexDirection === 'column';
        const anchor = flexCol && /end/.test(bcs.justifyContent) ? 'b' : flexCol && bcs.justifyContent === 'center' ? 'ctr' : 't';
        const paras = paragraphsOf(b, sr);
        if (!paras.length) continue;
        const br = rel(b.getBoundingClientRect());
        // A little room: the same words can run slightly wider in other programs.
        const extra = Math.max(4, br.w * 0.03), align = paras[0].align;
        const box = { x: align === 'r' ? br.x - extra : align === 'ctr' ? br.x - extra / 2 : br.x, y: br.y, w: br.w + extra, h: br.h };
        items.push({ type: 'text', box, anchor, paras });
      }
    });
    const notes = slide.querySelector(':scope > .notes');
    return {
      rect: { x: sr.left + scrollX, y: sr.top + scrollY, w: sr.width, h: sr.height },
      solid: solid && solid.alpha > 0 ? solid.hex : null, notes: notes ? [...notes.querySelectorAll('p')].map(p => p.textContent.trim()).filter(Boolean).join('\n') || notes.textContent.trim() : '',
      items, objectCount: objects.length,
    };
  });

  // What each capture shows: the background alone, or the pictures up to one (text always left out).
  window.__xp = (si, upTo) => {
    const slide = slides[si];
    slide.querySelectorAll('.xp-text').forEach(e => e.classList.add('xp-ink'));
    [...slide.children].forEach(el => { if (el.dataset.xp !== undefined) el.classList.toggle('xp-hide', upTo < 0 || +el.dataset.xp > upTo); });
    return true;
  };
  const root = getComputedStyle(document.documentElement);
  const accents = ['--accent', '--accent-2', '--accent-3', '--accent-4', '--accent-5', '--accent-6'].map(v => (/#([0-9a-f]{6})/i.exec(root.getPropertyValue(v)) || [])[1]?.toUpperCase()).filter(Boolean);
  const stage = document.querySelector('.stage');
  return {
    title: document.title, width: +stage.dataset.width || 1920, height: +stage.dataset.height || 1080, slides: data,
    theme: { body: firstFont(root.getPropertyValue('--font')), heading: firstFont(root.getPropertyValue('--font-heading') || root.getPropertyValue('--font')), accents },
  };
}

async function toPptx(dir, warnings, log) {
  const b = await openBrowser({ scale: 1.5 });
  try {
    await b.goto(pageUrl(dir));
    await b.json(READY);
    const page = await b.json(`(${analyzePage.toString()})()`);
    const slides = [];
    for (const [si, s] of page.slides.entries()) {
      log(`slide ${si + 1} of ${page.slides.length}`);
      const abs = box => ({ x: s.rect.x + box.x, y: s.rect.y + box.y, w: box.w, h: box.h });
      let background = { color: s.solid };
      if (!s.solid) { await b.json(`__xp(${si}, -1)`); background = { image: await b.shot(s.rect, true), ext: 'jpeg' }; }
      const shapes = [];
      for (const it of s.items) {
        if (it.type === 'text') { shapes.push(it); continue; }
        // A picture shows its object over everything below it (so overlaps stay right), without any text.
        await b.json(`__xp(${si}, ${it.object})`);
        shapes.push({ type: 'picture', box: it.box, name: it.name, image: await b.shot(abs(it.box)), ext: 'png' });
      }
      slides.push({ background, shapes, notes: s.notes });
    }
    if (page.slides.some(s => s.items.some(i => i.type === 'picture'))) warnings.push('Shapes, pictures and charts are pictures in the PowerPoint file; the text stays editable.');
    return writePptx({ title: page.title, width: page.width, height: page.height, theme: page.theme, slides });
  } finally { await b.close(); }
}

/* ── LibreOffice (.odp) ── */

function findSoffice() {
  const env = process.env, list = process.platform === 'darwin' ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
    : process.platform === 'win32' ? [`${env.ProgramFiles || 'C:\\Program Files'}\\LibreOffice\\program\\soffice.exe`, `${env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\LibreOffice\\program\\soffice.exe`]
      : ['soffice', 'libreoffice'];
  for (const c of list) {
    if (c.includes('/') || c.includes('\\')) { if (fs.existsSync(c)) return c; continue; }
    for (const d of (env.PATH || '').split(path.delimiter)) if (fs.existsSync(path.join(d, c))) return path.join(d, c);
  }
  return null;
}

function libreOffice(file, to, outdir) {
  const bin = findSoffice();
  if (!bin) return Promise.reject(new Error('Exporting to .odp needs LibreOffice installed (it converts the PowerPoint file). Export .pptx instead: LibreOffice opens it too.'));
  const profile = pathToFileURL(fs.mkdtempSync(path.join(os.tmpdir(), 'deckelsmouk-lo-'))).href; // its own profile: works while LibreOffice is open
  return new Promise((ok, no) => execFile(bin, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', to, '--outdir', outdir, file], { timeout: 180000 }, (err, stdout, stderr) => {
    if (err || !fs.existsSync(path.join(outdir, `${path.basename(file, path.extname(file))}.${to}`))) no(new Error(`LibreOffice could not convert the file: ${(stderr || err?.message || '').trim().split('\n').pop()}`));
    else ok();
  }));
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [name, format = 'html'] = process.argv.slice(2);
  if (!name) { console.log('Usage: npm run export -- <deck> [html|pdf|pptx|odp]'); process.exit(1); }
  exportDeck(name, format, { log: m => console.log(`  ${m}`) })
    .then(r => { console.log(`✓ ${path.relative(process.cwd(), r.file)} (${Math.round(r.bytes / 1024)} KB)`); r.warnings.forEach(w => console.log(`  ${w}`)); })
    .catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
}
