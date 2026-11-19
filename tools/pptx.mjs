// PowerPoint (.pptx / .potx) → Deckelsmouk template.
// Reads the theme (colours, fonts), the slide master (background, decorations, title and text styles) and every slide
// layout (background, decorations, placeholders) and writes deck.html + assets/. Decorations become CSS background
// layers of .slide, so they sit behind the content of every slide, as in PowerPoint's master. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { readZip, parseXML, kid, kids, at, findAll } from './ooxml.mjs';
import { deckSlug } from './lib.mjs';

const P = path.posix;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const px = v => `${Math.round(v)}px`;

/* ── Package: parts and relationships ── */

class Package {
  constructor(buf) { this.zip = readZip(buf); this.parsed = new Map(); }
  bytes(part) { const f = this.zip.get(part); return f ? f() : null; }
  xml(part) {
    if (!part) return null;
    if (!this.parsed.has(part)) { const b = this.bytes(part); this.parsed.set(part, b ? parseXML(b.toString('utf8')) : null); }
    return this.parsed.get(part);
  }
  rels(part) {
    const dir = P.dirname(part);
    const file = `${dir === '.' ? '' : dir + '/'}_rels/${P.basename(part)}.rels`;
    const out = new Map();
    for (const r of kids(this.xml(file), 'Relationship')) {
      const external = r.attrs.TargetMode === 'External', t = r.attrs.Target || '';
      out.set(r.attrs.Id, {
        type: (r.attrs.Type || '').split('/').pop(), external,
        target: external ? t : t.startsWith('/') ? t.slice(1) : P.normalize(P.join(dir, t)),
      });
    }
    return out;
  }
  rel(part, type) { for (const r of this.rels(part).values()) if (r.type === type && !r.external) return r.target; return null; }
}

/* ── Colours ── */

const toRgb = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0);
const toHex = c => c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => toHex(toRgb(a).map((v, i) => v * t + toRgb(b)[i] * (1 - t)));
const luminance = h => { const [r, g, b] = toRgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = ((t % 1) + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const PRESET = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080', darkGray: 'a9a9a9', lightGray: 'd3d3d3', orange: 'ffa500', navy: '000080' };
const DEFAULT_MAP = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink' };
// Theme colour roles → CSS tokens. Text and backgrounds that use a role stay linked to the theme.
const TOKEN = { bg1: '--bg', tx1: '--fg', bg2: '--bg-2', tx2: '--fg-2', accent1: '--accent', accent2: '--accent-2', accent3: '--accent-3', accent4: '--accent-4', accent5: '--accent-5', accent6: '--accent-6', hlink: '--link' };

// A colour element (a:srgbClr, a:schemeClr, …) → { hex, alpha, role }. role is kept while the colour is an
// unmodified theme role, so it can be written as var(--token).
function color(el, ctx, ph) {
  if (!el) return null;
  let c;
  switch (el.name) {
    case 'a:srgbClr': c = { hex: (el.attrs.val || '000000').toLowerCase() }; break;
    case 'a:sysClr': c = { hex: (el.attrs.lastClr || (el.attrs.val === 'window' ? 'ffffff' : '000000')).toLowerCase() }; break;
    case 'a:prstClr': c = { hex: PRESET[el.attrs.val] || '000000' }; break;
    case 'a:scrgbClr': c = { hex: toHex(['r', 'g', 'b'].map(k => 255 * Math.pow(Math.max(0, +el.attrs[k] / 100000), 1 / 2.2))) }; break;
    case 'a:hslClr': c = { hex: toHex(hslToRgb([+el.attrs.hue / 21600000, +el.attrs.sat / 100000, +el.attrs.lum / 100000])) }; break;
    case 'a:schemeClr': {
      const v = el.attrs.val;
      if (v === 'phClr') { if (!ph) return null; c = { ...ph }; break; }
      c = { hex: ctx.scheme[ctx.map[v] || v] || '000000', role: TOKEN[v] ? v : null };
      break;
    }
    default: return null;
  }
  c.alpha = c.alpha ?? 1;
  let rgb = toRgb(c.hex), changed = false;
  for (const m of el.kids) {
    const v = +m.attrs.val / 100000;
    if (m.name === 'a:alpha') c.alpha = v;
    else if (m.name === 'a:alphaMod') c.alpha *= v;
    else if (m.name === 'a:alphaOff') c.alpha = Math.min(1, c.alpha + v);
    else if (m.name === 'a:tint') { rgb = rgb.map(x => 255 - (255 - x) * v); changed = true; }
    else if (m.name === 'a:shade') { rgb = rgb.map(x => x * v); changed = true; }
    else if (/^a:(lum|sat|hue)(Mod|Off)$/.test(m.name)) {
      const hsl = rgbToHsl(rgb), i = { lum: 2, sat: 1, hue: 0 }[m.name.slice(2, 5)];
      if (m.name.endsWith('Mod')) hsl[i] *= v; else hsl[i] += i === 0 ? +m.attrs.val / 21600000 : v;
      hsl[i] = i === 0 ? ((hsl[i] % 1) + 1) % 1 : Math.max(0, Math.min(1, hsl[i]));
      rgb = hslToRgb(hsl); changed = true;
    }
  }
  if (changed) { c.hex = toHex(rgb); c.role = null; }
  return c;
}

function css(c) {
  if (!c) return null;
  const a = r2(c.alpha);
  if (c.role) return a < 1 ? `color-mix(in srgb, var(${TOKEN[c.role]}) ${Math.round(a * 100)}%, transparent)` : `var(${TOKEN[c.role]})`;
  if (a < 1) return `rgba(${toRgb(c.hex).join(', ')}, ${a})`;
  return '#' + c.hex;
}

/* ── Fills, lines, backgrounds ── */

// Fill of a properties element → {kind: solid|grad|image|none, …}; undefined when it sets none.
function fill(parent, ctx, ph) {
  for (const k of parent?.kids || []) {
    switch (k.name) {
      case 'a:noFill': return { kind: 'none' };
      case 'a:solidFill': { const c = color(kid(k), ctx, ph); return c ? { kind: 'solid', color: c } : { kind: 'none' }; }
      case 'a:gradFill': {
        const stops = kids(kid(k, 'a:gsLst'), 'a:gs').map(gs => ({ pos: +gs.attrs.pos / 1000, color: color(kid(gs), ctx, ph) }))
          .filter(s => s.color).sort((a, b) => a.pos - b.pos);
        const lin = kid(k, 'a:lin');
        if (!stops.length) return { kind: 'none' };
        return stops.length === 1 ? { kind: 'solid', color: stops[0].color } : { kind: 'grad', stops, angle: lin ? +lin.attrs.ang / 60000 : 90, radial: !!kid(k, 'a:path') };
      }
      case 'a:blipFill': return { kind: 'image', blipFill: k };
      case 'a:pattFill': { const c = color(kid(kid(k, 'a:fgClr')), ctx, ph); return c ? { kind: 'solid', color: c } : { kind: 'none' }; }
      case 'a:grpFill': return { kind: 'none' };
    }
  }
  return undefined;
}

// Theme fill style number (from a:fillRef / p:bgRef) → fill, with phClr standing for the given colour.
function styleFill(idx, phColor, ctx) {
  if (!idx) return { kind: 'none' };
  const fmt = at(ctx.theme, 'a:themeElements', 'a:fmtScheme');
  const list = kid(fmt, idx >= 1000 ? 'a:bgFillStyleLst' : 'a:fillStyleLst');
  const el = list?.kids[idx >= 1000 ? idx - 1001 : idx - 1];
  return (el && fill({ kids: [el] }, ctx, phColor)) || (phColor ? { kind: 'solid', color: phColor } : { kind: 'none' });
}

function shapeFill(spPr, style, ctx) {
  let f = fill(spPr, ctx);
  if (f === undefined) { const ref = kid(style, 'a:fillRef'); f = ref ? styleFill(+ref.attrs.idx, color(kid(ref), ctx), ctx) : null; }
  return f && f.kind !== 'none' ? f : null;
}

function line(spPr, style, ctx) {
  const ln = kid(spPr, 'a:ln');
  let f = ln ? fill(ln, ctx) : undefined, w = ln?.attrs.w;
  const ref = kid(style, 'a:lnRef');
  if ((f === undefined || w === undefined) && ref && +ref.attrs.idx) {
    const themeLn = kids(at(ctx.theme, 'a:themeElements', 'a:fmtScheme', 'a:lnStyleLst'), 'a:ln')[+ref.attrs.idx - 1];
    if (themeLn) {
      if (f === undefined) f = fill(themeLn, ctx, color(kid(ref), ctx));
      if (w === undefined) w = themeLn.attrs.w;
    }
  }
  if (!f || f.kind !== 'solid') return null;
  return { color: f.color, width: Math.max(1, (+w || 9525) * ctx.k), dash: at(ln, 'a:prstDash')?.attrs.val };
}

function gradCss(f) {
  const stops = f.stops.map(s => `${css(s.color)} ${r1(s.pos)}%`).join(', ');
  return f.radial ? `radial-gradient(circle, ${stops})` : `linear-gradient(${r1(f.angle + 90)}deg, ${stops})`;
}

// Background of a master or layout → CSS for the bottom background layer (with the colour), or null.
function background(cSld, part, ctx) {
  const bg = kid(cSld, 'p:bg');
  if (!bg) return null;
  const pr = kid(bg, 'p:bgPr'), ref = kid(bg, 'p:bgRef');
  const f = pr ? fill(pr, ctx) : ref ? styleFill(+ref.attrs.idx, color(kid(ref), ctx), ctx) : null;
  if (!f || f.kind === 'none') return null;
  if (f.kind === 'solid') return css(f.color);
  if (f.kind === 'grad') return gradCss(f);
  const img = media(part, kid(f.blipFill, 'a:blip'), ctx);
  if (!img) return null;
  return kid(f.blipFill, 'a:tile') ? `url("${img.src}") 0 0 repeat var(--bg)` : `url("${img.src}") 0 0 / 100% 100% no-repeat var(--bg)`;
}

// An image referenced by a:blip → copied to assets/ (once). Prefers the SVG Office keeps beside a PNG fallback.
function media(part, blip, ctx) {
  if (!blip) return null;
  const rels = ctx.pkg.rels(part);
  const svg = findAll(blip, 'asvg:svgBlip')[0] || blip.kids.flatMap(e => findAll(e, 'a:ext')).flatMap(e => e.kids).find(e => e.name.endsWith(':svgBlip'));
  const rel = rels.get(svg?.attrs['r:embed']) || rels.get(blip.attrs['r:embed']);
  if (!rel || rel.external) return null;
  if (ctx.media.has(rel.target)) return ctx.media.get(rel.target);
  const ext = P.extname(rel.target).toLowerCase();
  let out = null;
  if (!MIME[ext]) ctx.warn(`Skipped ${P.basename(rel.target)}: browsers can't show ${ext.slice(1).toUpperCase()} images. Export that picture as PNG or SVG and add it to assets/.`);
  else {
    const data = ctx.pkg.bytes(rel.target);
    if (data) out = { src: ctx.writeAsset(P.basename(rel.target), data), data, mime: MIME[ext] };
  }
  ctx.media.set(rel.target, out);
  return out;
}

/* ── Shape trees ── */

function xbox(xfrm, tf) {
  const off = kid(xfrm, 'a:off'), ext = kid(xfrm, 'a:ext');
  if (!off || !ext) return null;
  return {
    x: tf.ox + tf.sx * +off.attrs.x, y: tf.oy + tf.sy * +off.attrs.y, w: tf.sx * +ext.attrs.cx, h: tf.sy * +ext.attrs.cy, s: tf.sx,
    rot: +(xfrm.attrs.rot || 0) / 60000, flipH: xfrm.attrs.flipH === '1', flipV: xfrm.attrs.flipV === '1',
  };
}

// Splits a shape tree into placeholders and decorations, in drawing order, with boxes in stage pixels.
function walk(tree, part, tf, out = { ph: [], deco: [] }) {
  for (const el of tree?.kids || []) {
    if (el.name === 'mc:AlternateContent') { walk(kid(el, 'mc:Fallback') || kid(el, 'mc:Choice'), part, tf, out); continue; }
    if (el.name === 'p:grpSp') {
      const x = at(el, 'p:grpSpPr', 'a:xfrm');
      const off = kid(x, 'a:off'), ext = kid(x, 'a:ext'), co = kid(x, 'a:chOff'), ce = kid(x, 'a:chExt');
      let t = tf;
      if (off && ext && co && ce) {
        const gx = +ce.attrs.cx ? +ext.attrs.cx / +ce.attrs.cx : 1, gy = +ce.attrs.cy ? +ext.attrs.cy / +ce.attrs.cy : 1;
        t = { ox: tf.ox + tf.sx * (+off.attrs.x - +co.attrs.x * gx), oy: tf.oy + tf.sy * (+off.attrs.y - +co.attrs.y * gy), sx: tf.sx * gx, sy: tf.sy * gy };
      }
      walk(el, part, t, out);
      continue;
    }
    if (!['p:sp', 'p:pic', 'p:cxnSp', 'p:graphicFrame'].includes(el.name)) continue;
    const nv = el.kids.find(k => k.name.startsWith('p:nv'));
    if (kid(nv, 'p:cNvPr')?.attrs.hidden === '1') continue;
    const ph = at(nv, 'p:nvPr', 'p:ph');
    const xfrm = el.name === 'p:graphicFrame' ? kid(el, 'p:xfrm') : at(el, 'p:spPr', 'a:xfrm');
    const box = xfrm ? xbox(xfrm, tf) : null;
    if (ph) out.ph.push({ el, box, part, type: ph.attrs.type || 'obj', idx: ph.attrs.idx ?? null, custom: ph.attrs.hasCustomPrompt === '1' });
    else if (box && el.name !== 'p:graphicFrame') out.deco.push({ el, box, part });
  }
  return out;
}

const KIND = t => (t === 'title' || t === 'ctrTitle' ? 'title' : ['dt', 'ftr', 'sldNum', 'hdr'].includes(t) ? t : 'body');
const masterPh = (list, ph) => {
  const kind = KIND(ph.type);
  return list.find(m => KIND(m.type) === kind && m.idx === ph.idx) || list.find(m => KIND(m.type) === kind);
};

/* ── Text styles ── */

function readProps(pPr, rPr, ctx) {
  const o = {};
  if (pPr) {
    if (pPr.attrs.algn) o.algn = pPr.attrs.algn;
    const ls = at(pPr, 'a:lnSpc', 'a:spcPct'); if (ls) o.lnSpc = +ls.attrs.val / 100000;
    const sb = at(pPr, 'a:spcBef', 'a:spcPts'); if (sb) o.spcBef = +sb.attrs.val / 100;
    if (kid(pPr, 'a:buNone')) o.bullet = { none: true };
    const bc = kid(pPr, 'a:buChar'); if (bc) o.bullet = { char: bc.attrs.char, font: kid(pPr, 'a:buFont')?.attrs.typeface };
    if (kid(pPr, 'a:buAutoNum')) o.bullet = { num: true };
    const bclr = kid(pPr, 'a:buClr'); if (bclr) o.buClr = color(kid(bclr), ctx);
    rPr = rPr || kid(pPr, 'a:defRPr');
  }
  if (rPr) {
    if (rPr.attrs.sz) o.sz = +rPr.attrs.sz / 100;
    if (rPr.attrs.b) o.b = rPr.attrs.b === '1' || rPr.attrs.b === 'true';
    if (rPr.attrs.i) o.i = rPr.attrs.i === '1' || rPr.attrs.i === 'true';
    if (rPr.attrs.cap) o.cap = rPr.attrs.cap;
    const f = kid(rPr, 'a:solidFill'); if (f) o.color = color(kid(f), ctx);
    const lat = kid(rPr, 'a:latin'); if (lat?.attrs.typeface) o.font = lat.attrs.typeface;
  }
  return o;
}
const merge = (...list) => Object.assign({}, ...list.filter(Boolean).reverse()); // the first source wins

// What a placeholder's text looks like at level 1: its own formatting, then the master placeholder's, then the master text styles.
function phStyle(ph, mph, ctx) {
  const tx = kid(ph.el, 'p:txBody'), p1 = kid(tx, 'a:p'), run = kid(p1, 'a:r');
  const src = [
    p1 && readProps(kid(p1, 'a:pPr'), kid(run, 'a:rPr') || kid(p1, 'a:endParaRPr'), ctx),
    readProps(at(tx, 'a:lstStyle', 'a:lvl1pPr'), null, ctx),
  ];
  if (mph) src.push(readProps(at(mph.el, 'p:txBody', 'a:lstStyle', 'a:lvl1pPr'), null, ctx));
  const kind = KIND(ph.type);
  src.push(ctx.textStyles[kind === 'title' ? 'title' : kind === 'body' ? 'body' : 'other']);
  return merge(...src);
}

function bodyProps(ph, mph) {
  const a = { ...(at(mph?.el, 'p:txBody', 'a:bodyPr')?.attrs || {}), ...(at(ph.el, 'p:txBody', 'a:bodyPr')?.attrs || {}) };
  return { anchor: a.anchor || 't', l: +(a.lIns ?? 91440), r: +(a.rIns ?? 91440), t: +(a.tIns ?? 45720), b: +(a.bIns ?? 45720), vert: a.vert && a.vert !== 'horz' };
}

const paragraphs = el => kids(kid(el, 'p:txBody'), 'a:p')
  .map(p => p.kids.filter(r => r.name === 'a:r' || r.name === 'a:fld').map(r => kid(r, 'a:t')?.text || '').join(''))
  .filter(s => s.trim());

const SERIF = /times|georgia|garamond|cambria|palatino|antiqua|baskerville|constantia|caslon|didot|bodoni|minion|merriweather|playfair|serif/i;
const ALIAS = { calibri: 'Carlito', cambria: 'Caladea', arial: '"Liberation Sans"', 'times new roman': '"Liberation Serif"', 'courier new': '"Liberation Mono"', helvetica: 'Arial' };
function fontStack(name) {
  const q = n => (/^[\w-]+$/.test(n) ? n : `"${n.replace(/"/g, '')}"`);
  const serif = SERIF.test(name) && !/sans/i.test(name);
  const list = [q(name), ALIAS[name.toLowerCase()], ...(serif ? ['Georgia', '"Times New Roman"', 'serif'] : ['"Segoe UI"', '"Helvetica Neue"', 'Arial', 'sans-serif'])];
  const seen = new Set();
  return list.filter(f => f && !seen.has(f.replace(/"/g, '').toLowerCase()) && seen.add(f.replace(/"/g, '').toLowerCase())).join(', ');
}
function fontCss(f, ctx) {
  if (!f) return null;
  if (f === '+mj-lt' || f === ctx.fonts.major) return 'var(--font-heading)';
  if (f === '+mn-lt' || f === ctx.fonts.minor) return 'var(--font)';
  return f.startsWith('+') ? null : fontStack(f);
}

/* ── Decorations → background layers ── */

const layerAt = (img, b) => `${img} ${r1(b.x)}px ${r1(b.y)}px / ${r1(b.w)}px ${r1(b.h)}px no-repeat`;
const hasText = el => paragraphs(el).length > 0;

// Axis-aligned filled rectangles and straight lines become plain CSS layers (so they follow the theme colours).
function cssLayer(d, ctx) {
  const { el, box: b } = d;
  if (b.rot || hasText(el)) return null;
  const spPr = kid(el, 'p:spPr'), style = kid(el, 'p:style');
  const prst = kid(spPr, 'a:prstGeom')?.attrs.prst;
  if (el.name === 'p:sp' && prst === 'rect') {
    const f = shapeFill(spPr, style, ctx);
    if (!f || line(spPr, style, ctx)) return null;
    if (f.kind === 'solid') return layerAt(`linear-gradient(${css(f.color)}, ${css(f.color)})`, b);
    if (f.kind === 'grad') return layerAt(gradCss(f), b);
    return null;
  }
  if ((el.name === 'p:cxnSp' || prst === 'line' || prst === 'straightConnector1') && (b.w < 0.5 || b.h < 0.5)) {
    const ln = line(spPr, style, ctx);
    if (!ln || (ln.dash && ln.dash !== 'solid')) return null;
    const r = b.h < 0.5 ? { x: b.x, y: b.y - ln.width / 2, w: b.w, h: ln.width } : { x: b.x - ln.width / 2, y: b.y, w: ln.width, h: b.h };
    return layerAt(`linear-gradient(${css(ln.color)}, ${css(ln.color)})`, r);
  }
  return null;
}

// Pictures become a layer of their own; cropped, rotated or faded ones get a small SVG wrapper that does it.
function pictureLayer(d, blipFill, ctx, scope) {
  const img = media(d.part, kid(blipFill, 'a:blip'), ctx);
  if (!img) return null;
  const b = d.box, sr = kid(blipFill, 'a:srcRect');
  const [l, t, r, bt] = ['l', 't', 'r', 'b'].map(k => +(sr?.attrs[k] || 0) / 100000);
  const amt = findAll(kid(blipFill, 'a:blip'), 'a:alphaModFix')[0]?.attrs.amt;
  const op = amt ? +amt / 100000 : 1;
  if (!(l || t || r || bt) && !b.rot && !b.flipH && !b.flipV && op === 1) return layerAt(`url("${img.src}")`, b);
  const iw = b.w / (1 - l - r || 1), ih = b.h / (1 - t - bt || 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r1(b.w)}" height="${r1(b.h)}" viewBox="0 0 ${r1(b.w)} ${r1(b.h)}">`
    + `<image href="data:${img.mime};base64,${img.data.toString('base64')}" x="${r1(-l * iw)}" y="${r1(-t * ih)}" width="${r1(iw)}" height="${r1(ih)}" preserveAspectRatio="none"`
    + `${op < 1 ? ` opacity="${r2(op)}"` : ''}${transform({ x: 0, y: 0, w: b.w, h: b.h, rot: b.rot, flipH: b.flipH, flipV: b.flipV })}/></svg>\n`;
  return layerAt(`url("${ctx.writeAsset(`${scope}-picture.svg`, svg)}")`, b);
}

function transform(b, flips = true) {
  const cx = r1(b.x + b.w / 2), cy = r1(b.y + b.h / 2), t = [];
  if (b.rot) t.push(`rotate(${r1(b.rot)} ${cx} ${cy})`);
  if (flips && (b.flipH || b.flipV)) t.push(`translate(${cx} ${cy}) scale(${b.flipH ? -1 : 1} ${b.flipV ? -1 : 1}) translate(${-cx} ${-cy})`);
  return t.length ? ` transform="${t.join(' ')}"` : '';
}

function geometry(el, spPr, b, ctx) {
  const cust = kid(spPr, 'a:custGeom');
  if (cust) return { svg: customPath(cust, b) };
  const prst = kid(spPr, 'a:prstGeom')?.attrs.prst || (el.name === 'p:cxnSp' ? 'line' : 'rect');
  const adj = (n, def) => {
    const gd = kids(at(spPr, 'a:prstGeom', 'a:avLst'), 'a:gd').find(g => g.attrs.name === n);
    const m = /val\s+(-?\d+)/.exec(gd?.attrs.fmla || '');
    return (m ? +m[1] : def) / 100000;
  };
  const { x, y, w, h } = b, m = Math.min(w, h);
  const poly = pts => `<polygon points="${pts.map(p => p.map(r1).join(',')).join(' ')}"/>`;
  if (el.name === 'p:cxnSp' || /line|connector/i.test(prst)) {
    const [x1, x2] = b.flipH ? [x + w, x] : [x, x + w], [y1, y2] = b.flipV ? [y + h, y] : [y, y + h];
    return { svg: `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`, flipped: true, line: true };
  }
  switch (prst) {
    case 'rect': return { svg: `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}"/>` };
    case 'roundRect': return { svg: `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(m * adj('adj', 16667))}"/>` };
    case 'ellipse': case 'flowChartConnector': return { svg: `<ellipse cx="${r1(x + w / 2)}" cy="${r1(y + h / 2)}" rx="${r1(w / 2)}" ry="${r1(h / 2)}"/>` };
    case 'triangle': return { svg: poly([[x + w * adj('adj', 50000), y], [x + w, y + h], [x, y + h]]) };
    case 'rtTriangle': return { svg: poly([[x, y], [x + w, y + h], [x, y + h]]) };
    case 'diamond': return { svg: poly([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]]) };
    case 'parallelogram': { const o = m * adj('adj', 25000); return { svg: poly([[x + o, y], [x + w, y], [x + w - o, y + h], [x, y + h]]) }; }
    case 'trapezoid': { const o = m * adj('adj', 25000); return { svg: poly([[x, y + h], [x + o, y], [x + w - o, y], [x + w, y + h]]) }; }
    case 'homePlate': { const o = m * adj('adj', 50000); return { svg: poly([[x, y], [x + w - o, y], [x + w, y + h / 2], [x + w - o, y + h], [x, y + h]]) }; }
    case 'chevron': { const o = m * adj('adj', 50000); return { svg: poly([[x, y], [x + w - o, y], [x + w, y + h / 2], [x + w - o, y + h], [x, y + h], [x + o, y + h / 2]]) }; }
    case 'hexagon': { const o = m * adj('adj', 25000); return { svg: poly([[x + o, y], [x + w - o, y], [x + w, y + h / 2], [x + w - o, y + h], [x + o, y + h], [x, y + h / 2]]) }; }
    case 'pentagon': return { svg: poly([[x + w / 2, y], [x + w, y + h * 0.38], [x + w * 0.81, y + h], [x + w * 0.19, y + h], [x, y + h * 0.38]]) };
    case 'octagon': { const o = m * adj('adj', 29289); return { svg: poly([[x + o, y], [x + w - o, y], [x + w, y + o], [x + w, y + h - o], [x + w - o, y + h], [x + o, y + h], [x, y + h - o], [x, y + o]]) }; }
    case 'snip1Rect': { const o = m * adj('adj', 16667); return { svg: poly([[x, y], [x + w - o, y], [x + w, y + o], [x + w, y + h], [x, y + h]]) }; }
    case 'flowChartAlternateProcess': return { svg: `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(m / 6)}"/>` };
    case 'round1Rect': case 'round2SameRect': {
      // Rounded top-right corner (round1Rect), or rounded top corners and optionally bottom ones (round2SameRect).
      const a = r1(m * adj('adj1', 16667)) || r1(m * adj('adj', 16667)), b2 = prst === 'round2SameRect' ? r1(m * adj('adj2', 0)) : 0;
      const tl = prst === 'round2SameRect' ? a : 0, tr = a, br = b2, bl = b2;
      return { svg: `<path d="M${r1(x + tl)} ${r1(y)}H${r1(x + w - tr)}A${tr} ${tr} 0 0 1 ${r1(x + w)} ${r1(y + tr)}V${r1(y + h - br)}A${br} ${br} 0 0 1 ${r1(x + w - br)} ${r1(y + h)}H${r1(x + bl)}A${bl} ${bl} 0 0 1 ${r1(x)} ${r1(y + h - bl)}V${r1(y + tl)}A${tl} ${tl} 0 0 1 ${r1(x + tl)} ${r1(y)}Z"/>` };
    }
    case 'flowChartDocument': { // a band with a wavy bottom edge
      const X = v => r1(x + (w * v) / 21600), Y = v => r1(y + (h * v) / 21600);
      return { svg: `<path d="M${X(0)} ${Y(0)}L${X(21600)} ${Y(0)}L${X(21600)} ${Y(17322)}C${X(10800)} ${Y(17322)} ${X(10800)} ${Y(23922)} ${X(0)} ${Y(20172)}Z"/>` };
    }
    default:
      ctx.stats.approximated++;
      return { svg: `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}"/>` };
  }
}

// a:custGeom → SVG path(s). Coordinates are in each path's own w×h space (or EMU of the shape when absent).
function customPath(geom, b) {
  const out = [];
  for (const p of kids(kid(geom, 'a:pathLst'), 'a:path')) {
    const pw = +p.attrs.w || 0, phh = +p.attrs.h || 0;
    const sx = pw ? b.w / pw : b.s, sy = phh ? b.h / phh : b.s;
    const num = (v, full) => (/^-?\d+(\.\d+)?$/.test(v) ? +v : v === 'w' || v === 'r' ? full : v === 'hc' || v === 'vc' ? full / 2 : 0);
    const X = v => r1(b.x + num(v, pw || b.w / b.s) * sx), Y = v => r1(b.y + num(v, phh || b.h / b.s) * sy);
    let d = '', cx = 0, cy = 0;
    for (const c of p.kids) {
      const pts = kids(c, 'a:pt').map(pt => [pt.attrs.x, pt.attrs.y]);
      switch (c.name) {
        case 'a:moveTo': d += `M${X(pts[0][0])} ${Y(pts[0][1])}`; [cx, cy] = pts[0].map(Number); break;
        case 'a:lnTo': d += `L${X(pts[0][0])} ${Y(pts[0][1])}`; [cx, cy] = pts[0].map(Number); break;
        case 'a:cubicBezTo': d += `C${pts.map(q => `${X(q[0])} ${Y(q[1])}`).join(' ')}`; [cx, cy] = pts[2].map(Number); break;
        case 'a:quadBezTo': d += `Q${pts.map(q => `${X(q[0])} ${Y(q[1])}`).join(' ')}`; [cx, cy] = pts[1].map(Number); break;
        case 'a:arcTo': {
          const wR = +c.attrs.wR, hR = +c.attrs.hR, st = (+c.attrs.stAng / 60000) * Math.PI / 180, sw = (+c.attrs.swAng / 60000) * Math.PI / 180;
          const ox = cx - wR * Math.cos(st), oy = cy - hR * Math.sin(st);
          const ex = ox + wR * Math.cos(st + sw), ey = oy + hR * Math.sin(st + sw);
          d += `A${r1(wR * sx)} ${r1(hR * sy)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${X(ex)} ${Y(ey)}`;
          cx = ex; cy = ey;
          break;
        }
        case 'a:close': d += 'Z'; break;
      }
    }
    if (d) out.push(`<path d="${d}"${p.attrs.fill === 'none' ? ' fill="none"' : ''}${p.attrs.stroke === '0' || p.attrs.stroke === 'false' ? ' stroke="none"' : ''}/>`);
  }
  return out.join('');
}

function svgGradient(id, f) {
  const a = (f.angle * Math.PI) / 180, c = Math.cos(a) / 2, s = Math.sin(a) / 2;
  const stops = f.stops.map(st => `<stop offset="${r1(st.pos)}%" stop-color="#${st.color.hex}"${st.color.alpha < 1 ? ` stop-opacity="${r2(st.color.alpha)}"` : ''}/>`).join('');
  return f.radial ? `<radialGradient id="${id}">${stops}</radialGradient>`
    : `<linearGradient id="${id}" x1="${r2(0.5 - c)}" y1="${r2(0.5 - s)}" x2="${r2(0.5 + c)}" y2="${r2(0.5 + s)}">${stops}</linearGradient>`;
}

// Text in a decoration (a "www…" line, a confidentiality note): one SVG line per paragraph, without wrapping.
function shapeText(el, b, ctx) {
  const tx = kid(el, 'p:txBody');
  const bp = kid(tx, 'a:bodyPr')?.attrs || {};
  if (!tx || (bp.vert && bp.vert !== 'horz')) return '';
  const base = merge(readProps(at(tx, 'a:lstStyle', 'a:lvl1pPr'), null, ctx), ctx.textStyles.other);
  const lines = kids(tx, 'a:p').map(p => {
    const runs = p.kids.filter(r => r.name === 'a:r' || r.name === 'a:fld');
    const st = merge(readProps(kid(p, 'a:pPr'), kid(runs[0], 'a:rPr') || kid(p, 'a:endParaRPr'), ctx), base);
    return { text: runs.map(r => kid(r, 'a:t')?.text || '').join(''), st, size: (st.sz || 18) * ctx.ptPx };
  }).filter(l => l.text.trim());
  if (!lines.length) return '';
  const k = ctx.k, l = +(bp.lIns ?? 91440) * k, r = +(bp.rIns ?? 91440) * k, t = +(bp.tIns ?? 45720) * k, bb = +(bp.bIns ?? 45720) * k;
  const total = lines.reduce((s, ln) => s + ln.size * 1.2, 0);
  let y = bp.anchor === 'b' ? b.y + b.h - bb - total : bp.anchor === 'ctr' ? b.y + (b.h - total) / 2 : b.y + t;
  return lines.map(ln => {
    y += ln.size * 1.2;
    const al = ln.st.algn === 'ctr' ? 'middle' : ln.st.algn === 'r' ? 'end' : 'start';
    const x = al === 'middle' ? b.x + b.w / 2 : al === 'end' ? b.x + b.w - r : b.x + l;
    const c = ln.st.color || { hex: ctx.scheme[ctx.map.tx1] || '000000', alpha: 1 };
    const font = fontStack(ln.st.font && !ln.st.font.startsWith('+') ? ln.st.font : ln.st.font === '+mj-lt' ? ctx.fonts.major : ctx.fonts.minor).replace(/"/g, "'");
    return `<text x="${r1(x)}" y="${r1(y - ln.size * 0.25)}" font-size="${r1(ln.size)}" font-family="${font}" fill="#${c.hex}"${c.alpha < 1 ? ` fill-opacity="${r2(c.alpha)}"` : ''}`
      + `${ln.st.b ? ' font-weight="700"' : ''}${ln.st.i ? ' font-style="italic"' : ''}${al !== 'start' ? ` text-anchor="${al}"` : ''}>${esc(ln.st.cap === 'all' ? ln.text.toUpperCase() : ln.text)}</text>`;
  }).join('');
}

function shapeSvg(d, ctx, defs) {
  const { el, box: b } = d;
  const spPr = kid(el, 'p:spPr'), style = kid(el, 'p:style');
  const f = el.name === 'p:cxnSp' ? null : shapeFill(spPr, style, ctx);
  const ln = line(spPr, style, ctx);
  const g = geometry(el, spPr, b, ctx);
  let out = '';
  if ((f || ln) && g.svg && !(g.line && !ln)) {
    const paint = [];
    if (f?.kind === 'solid' && !g.line) paint.push(`fill="#${f.color.hex}"${f.color.alpha < 1 ? ` fill-opacity="${r2(f.color.alpha)}"` : ''}`);
    else if (f?.kind === 'grad' && !g.line) { const id = `g${defs.length + 1}`; defs.push(svgGradient(id, f)); paint.push(`fill="url(#${id})"`); }
    else paint.push('fill="none"');
    if (ln) {
      paint.push(`stroke="#${ln.color.hex}" stroke-width="${r1(ln.width)}"${ln.color.alpha < 1 ? ` stroke-opacity="${r2(ln.color.alpha)}"` : ''}`);
      if (ln.dash && ln.dash !== 'solid') paint.push(`stroke-dasharray="${r1(ln.width * 3)} ${r1(ln.width * 2)}"`);
    }
    out += `<g ${paint.join(' ')}${transform(b, !g.flipped)}>${g.svg}</g>`;
  }
  const text = shapeText(el, b, ctx);
  if (text) out += b.rot ? `<g${transform(b, false)}>${text}</g>` : text;
  return out;
}

// Decorations of a master or layout → CSS background layers, bottom first. Shapes in a row share one SVG file.
function decorations(items, ctx, scope) {
  const layers = [];
  let run = [], defs = [];
  const flush = () => {
    if (!run.length) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ctx.W}" height="${ctx.H}" viewBox="0 0 ${ctx.W} ${ctx.H}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${run.join('')}</svg>\n`;
    layers.push(`url("${ctx.writeAsset(`${scope}.svg`, svg)}") 0 0 / 100% 100% no-repeat`);
    run = []; defs = [];
  };
  for (const d of items) {
    try {
      const bf = d.el.name === 'p:pic' ? kid(d.el, 'p:blipFill') : kid(kid(d.el, 'p:spPr'), 'a:blipFill');
      if (bf) { const l = pictureLayer(d, bf, ctx, scope); if (l) { flush(); layers.push(l); } continue; }
      const l = cssLayer(d, ctx);
      if (l) { flush(); layers.push(l); continue; }
      const s = shapeSvg(d, ctx, defs);
      if (s) run.push(s);
    } catch (e) { ctx.warn(`Skipped a shape on ${scope}: ${e.message}`); }
  }
  flush();
  return layers;
}

/* ── Placeholders → slide elements ── */

const TYPE_NAMES = { title: 'Title slide', obj: 'Title and content', tx: 'Title and text', secHead: 'Section header', twoObj: 'Two content', twoTxTwoObj: 'Comparison', titleOnly: 'Title only', blank: 'Blank', objTx: 'Content with caption', picTx: 'Picture with caption', vertTx: 'Vertical text', cust: 'Custom' };
const MEDIA = new Set(['pic', 'chart', 'tbl', 'dgm', 'media', 'clipArt']);

function placeholderHTML(ph, mph, ctx, cls, used, layoutType) {
  const box = ph.box || mph?.box;
  if (!box || box.w < 4 || box.h < 4 || ph.type === 'dt' || ph.type === 'hdr') return '';
  const name = base => { let n = base, i = 1; while (used.has(n)) n = `${base}-${++i}`; used.add(n); return n; };
  const full = `position:absolute;left:${px(box.x)};top:${px(box.y)};width:${px(box.w)};height:${px(box.h)}`;
  if (MEDIA.has(ph.type)) return `<div class="ph-image" data-el="${name('image')}" style="${full}"></div>`;

  const st = phStyle(ph, mph, ctx), bp = bodyProps(ph, mph), k = ctx.k;
  const inner = { x: box.x + bp.l * k, y: box.y + bp.t * k, w: box.w - (bp.l + bp.r) * k, h: box.h - (bp.t + bp.b) * k };
  const pos = `position:absolute;left:${px(inner.x)};top:${px(inner.y)};width:${px(inner.w)};height:${px(inner.h)}`;
  const own = ph.custom ? paragraphs(ph.el) : [];
  const style = base => {
    const s = [];
    const size = st.sz ? r1(st.sz * ctx.ptPx) : null;
    if (size && Math.abs(size - base.size) > 1.5) s.push(`font-size:${size}px`);
    const c = css(st.color); if (c && c !== base.color) s.push(`color:${c}`);
    const f = fontCss(st.font, ctx); if (f && f !== base.font) s.push(`font-family:${f}`);
    if (st.b !== undefined && (st.b ? 700 : 400) !== base.weight) s.push(`font-weight:${st.b ? 700 : 400}`);
    if (st.i) s.push('font-style:italic');
    if (st.cap === 'all' && base.cap !== 'all') s.push('text-transform:uppercase');
    const al = { ctr: 'center', r: 'right', just: 'justify' }[st.algn]; if (al) s.push(`text-align:${al}`);
    if (bp.anchor === 'ctr' || bp.anchor === 'b') s.push(`display:flex;flex-direction:column;justify-content:${bp.anchor === 'b' ? 'flex-end' : 'center'}`);
    return (pos + (s.length ? ';' + s.join(';') : '')).replace(/"/g, "'"); // font names stay inside style="…"
  };

  switch (ph.type) {
    case 'sldNum': return `<p class="small slide-num" data-el="${name('slide-number')}" style="${style(cls.small)}"></p>`;
    case 'ftr': {
      const t = paragraphs(ph.el).concat(mph ? paragraphs(mph.el) : []).find(s => !/^\s*<[^>]*>\s*$/.test(s)); // not "<footer>" fields
      return t ?`<p class="small" data-el="${name('footer')}" style="${style(cls.small)}">${esc(t)}</p>` : '';
    }
    case 'ctrTitle': return `<h1 class="h1" data-el="${name('title')}" data-anim="rise" style="${style(cls.h1)}">${esc(own[0] || 'Presentation title')}</h1>`;
    case 'title': return `<h2 class="h2" data-el="${name('title')}" data-anim="rise" style="${style(cls.h2)}">${esc(own[0] || (layoutType === 'secHead' ? 'Section title' : 'Slide title'))}</h2>`;
    case 'subTitle': return `<p class="lead" data-el="${name('subtitle')}" data-anim="rise" data-delay="0.2" style="${style(cls.lead)}">${own.map(esc).join('<br>') || 'Subtitle'}</p>`;
  }
  const bullets = st.bullet && !st.bullet.none;
  if (bullets) {
    const items = own.length ? own : ['First point', 'Second point', 'Third point'];
    return `<ul class="list" data-el="${name('text')}" data-anim="rise" data-delay="0.2" style="${style(cls.body)}">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
  }
  const text = own.map(esc).join('<br>') || (layoutType === 'secHead' ? 'A sentence about this section' : 'Text');
  return `<p class="body" data-el="${name('text')}" data-anim="rise" data-delay="0.2" style="${style(cls.body)}">${text}</p>`;
}

// Wingdings / Symbol bullet characters → what they look like.
const DINGBATS = { '§': '▪', 'Ø': '➢', 'ü': '✓', 'q': '❑', 'v': '❖', 'n': '■', 'l': '●', 'Ÿ': '•', 'o': '○', 'w': '◆', 'à': '→', 'è': '➔', 'ð': '➔' };
function bulletChar(b) {
  if (!b || b.none) return null;
  if (b.num) return '•';
  if (/wingdings|symbol|webdings/i.test(b.font || '')) return DINGBATS[b.char] || (b.char === '·' ? '•' : '•');
  return b.char || '•';
}

/* ── The stylesheet ── */

function stylesheet(t) {
  const { tokens, cls, list, master, layouts, source, W, H, fonts } = t;
  const cssStr = s => `"${s.replace(/["\\]/g, '\\$&')}"`;
  const typeRow = (sel, c, extra = '') => `  ${sel.padEnd(9)}{ font-family: ${c.font}; font-size: ${c.size}px; font-weight: ${c.weight}; line-height: ${c.lh};${c.color ? ` color: ${c.color};` : ''}${c.cap === 'all' ? ' text-transform: uppercase;' : ''}${extra} }`;
  return `
  /* ── Theme ── Imported from ${source}. The stage is ${W} x ${H} px; every size below is in stage pixels.
     Colours and fonts come from the PowerPoint theme.${fonts.length ? ` Fonts used: ${fonts.join(', ')}. If a font isn't installed where
     you present, put its files (.woff2/.ttf) in assets/ and add an @font-face rule here, so it travels with the deck.` : ''} */
  :root {
${Object.entries(tokens).map(([k, v]) => `    ${k}: ${v};`).join('\n')}
  }
  .stage { font-family: var(--font); color: var(--fg); }
  .stage p, .stage h1, .stage h2, .stage h3, .stage ul { margin: 0; }

  /* Type scale (from the slide master): .h1 title slide, .h2 slide titles, .lead subtitles, .body and .list text */
${typeRow('.hero', { ...cls.h1, size: cls.hero }, ' letter-spacing: -.01em;')}
${typeRow('.h1', cls.h1)}
${typeRow('.h2', cls.h2)}
${typeRow('.h3', { ...cls.h2, size: cls.h3, lh: 1.2 })}
${typeRow('.lead', cls.lead)}
${typeRow('.body', cls.body)}
${typeRow('.small', cls.small)}
  .eyebrow { font-size: ${Math.round(cls.body.size * 0.8)}px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
  .mono    { font-family: var(--mono); }
  .muted   { color: var(--muted); }
  .accent  { color: var(--accent); }
  .accent-2 { color: var(--accent-2); }
  .center  { text-align: center; }
  .grad    { background: linear-gradient(95deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }

  /* Building blocks */
  .card  { background: color-mix(in srgb, var(--fg) 5%, transparent); border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent); border-radius: 20px; padding: 40px; box-sizing: border-box; }
  .pill  { display: inline-block; padding: 8px 22px; border-radius: 40px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-weight: 600; font-size: ${Math.round(cls.small.size)}px; }
  .list  { list-style: none; padding: 0; display: grid; align-content: start; gap: ${list.gap}px; font-family: ${cls.body.font}; font-size: ${cls.body.size}px; line-height: ${cls.body.lh};${cls.body.color ? ` color: ${cls.body.color};` : ''} }
  .list li { padding-left: 1.2em; text-indent: -1.2em; }
  .list li::before { ${list.char ? `content: ${cssStr(list.char)}; display: inline-block; width: 1.2em; text-indent: 0;${list.color ? ` color: ${list.color};` : ''}` : 'content: none;'} }
  .stat  { font-family: ${cls.h1.font}; font-size: ${Math.round(cls.hero * 1.3)}px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  .glow  { border-radius: 50%; filter: blur(140px); opacity: .3; pointer-events: none; }
  .slide.is-current .glow { animation: deck-breathe 9s ease-in-out infinite alternate; }
  @keyframes deck-breathe { from { scale: 1; } to { scale: 1.15; translate: 30px -20px; } }
  img.fit { object-fit: cover; }

  /* Placeholders: empty image boxes show while editing only (like PowerPoint); .slide-num shows the slide number. */
  .ph-image { box-sizing: border-box; border: 3px dashed color-mix(in srgb, var(--fg) 30%, transparent); background: color-mix(in srgb, var(--fg) 6%, transparent); }
  .ph-image::after { content: "Image"; position: absolute; inset: 0; display: grid; place-items: center; font: 500 28px var(--font); color: var(--muted); }
  body.is-presenting .ph-image, body.is-print .ph-image { visibility: hidden; }
  .stage { counter-reset: deck-slide; }
  .stage > .slide { counter-increment: deck-slide; }
  .slide-num::before { content: counter(deck-slide); }

  /* ── Slide master ── Every slide's background: --master holds the decorations (background layers, first = topmost),
     --master-bg the background itself. Layouts below reuse both. */
  .slide {
    ${master} }
${layouts.length ? `
  /* ── Layouts ── A slide's data-layout picks one; it replaces the master background where the layout has its own. */
${layouts.join('\n')}` : ''}
`;
}

/* ── Main ── */

/**
 * Converts a .pptx/.potx (as a Buffer) into a template in `dir` (deck.html + assets/).
 * Returns a report: { layouts, colors, fonts, images, warnings, size, slides }.
 */
export function pptxToTemplate(buf, dir, { title = 'Imported template', source = 'presentation.pptx' } = {}) {
  const pkg = new Package(buf);
  const main = pkg.rel('', 'officeDocument');
  const pres = pkg.xml(main);
  if (!pres || pres.name !== 'p:presentation') throw new Error('there is no PowerPoint presentation inside this file');
  const sz = kid(pres, 'p:sldSz');
  const cx = +(sz?.attrs.cx || 12192000), cy = +(sz?.attrs.cy || 6858000);
  const H = 1080, k = H / cy;
  let W = Math.round(cx * k);
  if (Math.abs(W - 1920) <= 2) W = 1920;

  const presRels = pkg.rels(main);
  const masters = kids(kid(pres, 'p:sldMasterIdLst'), 'p:sldMasterId').map(m => presRels.get(m.attrs['r:id'])?.target).filter(Boolean);
  if (!masters.length) throw new Error('the file has no slide master');
  const slides = kids(kid(pres, 'p:sldIdLst'), 'p:sldId').map(s => presRels.get(s.attrs['r:id'])?.target).filter(Boolean);
  const uses = new Map();
  for (const s of slides) { const l = pkg.rel(s, 'slideLayout'), m = l && pkg.rel(l, 'slideMaster'); if (m) uses.set(m, (uses.get(m) || 0) + 1); }
  const masterPart = [...uses].sort((a, b) => b[1] - a[1])[0]?.[0] || masters[0];
  const master = pkg.xml(masterPart);
  const theme = pkg.xml(pkg.rel(masterPart, 'theme'));

  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const written = new Set();
  const ctx = {
    pkg, theme, k, ptPx: k * 12700, W, H, dir,
    scheme: {}, map: { ...DEFAULT_MAP, ...(kid(master, 'p:clrMap')?.attrs || {}) },
    fonts: {
      major: at(theme, 'a:themeElements', 'a:fontScheme', 'a:majorFont', 'a:latin')?.attrs.typeface || '',
      minor: at(theme, 'a:themeElements', 'a:fontScheme', 'a:minorFont', 'a:latin')?.attrs.typeface || '',
    },
    media: new Map(), warnings: [], stats: { approximated: 0 },
    warn(m) { if (!this.warnings.includes(m)) this.warnings.push(m); },
    writeAsset(name, data) {
      const ext = P.extname(name), stem = P.basename(name, ext).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'asset';
      let file = stem + ext.toLowerCase(), i = 1;
      while (written.has(file)) file = `${stem}-${++i}${ext.toLowerCase()}`;
      written.add(file);
      fs.writeFileSync(path.join(dir, 'assets', file), data);
      return `assets/${file}`;
    },
  };
  for (const c of at(theme, 'a:themeElements', 'a:clrScheme')?.kids || []) {
    const col = color(kid(c), ctx);
    if (col) ctx.scheme[c.name.replace(/^a:/, '')] = col.hex;
  }
  const defaults = readProps(at(pres, 'p:defaultTextStyle', 'a:lvl1pPr'), null, ctx);
  const txStyles = kid(master, 'p:txStyles');
  ctx.textStyles = {
    title: merge(readProps(at(txStyles, 'p:titleStyle', 'a:lvl1pPr'), null, ctx), defaults, { sz: 44 }),
    body: merge(readProps(at(txStyles, 'p:bodyStyle', 'a:lvl1pPr'), null, ctx), defaults, { sz: 28 }),
    other: merge(readProps(at(txStyles, 'p:otherStyle', 'a:lvl1pPr'), null, ctx), defaults, { sz: 18 }),
  };

  // Theme tokens.
  const role = r => ctx.scheme[ctx.map[r]] || (r === 'bg1' ? 'ffffff' : '000000');
  const tokens = {
    '--bg': '#' + role('bg1'), '--fg': '#' + role('tx1'), '--bg-2': '#' + role('bg2'), '--fg-2': '#' + role('tx2'),
    '--muted': '#' + mix(role('tx1'), role('bg1'), 0.6), '--line': '#' + mix(role('tx1'), role('bg1'), 0.15),
  };
  for (let i = 1; i <= 6; i++) tokens[i === 1 ? '--accent' : `--accent-${i}`] = '#' + (ctx.scheme[`accent${i}`] || '4472c4');
  tokens['--link'] = '#' + (ctx.scheme.hlink || ctx.scheme.accent1 || '0563c1');
  tokens['--good'] = '#2e9d4f';
  tokens['--bad'] = '#d93f3f';
  tokens['--font'] = ctx.fonts.minor ? fontStack(ctx.fonts.minor) : '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
  tokens['--font-heading'] = ctx.fonts.major ? fontStack(ctx.fonts.major) : 'var(--font)';
  tokens['--mono'] = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';

  // Master.
  const tf0 = { ox: 0, oy: 0, sx: k, sy: k };
  const m = walk(at(master, 'p:cSld', 'p:spTree'), masterPart, tf0);
  const masterBg = background(kid(master, 'p:cSld'), masterPart, ctx);
  const masterLayers = decorations(m.deco, ctx, 'master');

  // Layouts (read first: the title slide's styles set the .h1 and .lead classes).
  const mrels = pkg.rels(masterPart);
  const keys = new Set();
  const layouts = kids(kid(master, 'p:sldLayoutIdLst'), 'p:sldLayoutId').map(l => mrels.get(l.attrs['r:id'])?.target).filter(Boolean).map(part => {
    const x = pkg.xml(part);
    if (!x) return null;
    const cSld = kid(x, 'p:cSld');
    const ovr = at(x, 'p:clrMapOvr', 'a:overrideClrMapping');
    const lctx = ovr ? Object.assign(Object.create(ctx), { map: { ...DEFAULT_MAP, ...ovr.attrs } }) : ctx;
    return { part, x, cSld, ovr, ctx: lctx, type: x.attrs.type || 'cust', name: (cSld?.attrs.name || '').trim(), tree: walk(at(cSld, 'p:spTree'), part, tf0) };
  }).filter(Boolean).filter(l => {
    // Vertical-text layouts (East Asian typesetting) don't make sense as HTML layouts.
    const vertical = l.tree.ph.some(ph => bodyProps(ph, masterPh(m.ph, ph)).vert);
    if (vertical) ctx.warn(`Left out the vertical-text layout "${l.name || l.type}".`);
    return !vertical;
  });
  const seen = new Map();
  layouts.forEach(l => seen.set(l.name, (seen.get(l.name) || 0) + 1));
  for (const l of layouts) {
    if (!l.name || seen.get(l.name) > 1) l.name = [l.name, TYPE_NAMES[l.type] || 'Layout'].filter(Boolean).join(' · ');
    let key = deckSlug(l.name), i = 1;
    while (keys.has(key)) key = `${deckSlug(l.name)}-${++i}`;
    keys.add(key);
    l.key = key;
  }

  // Classes from the master's title and text styles (and the title slide for .h1 / .lead).
  const findPh = type => { for (const l of layouts) { const p = l.tree.ph.find(q => q.type === type); if (p) return { p, l }; } return null; };
  const effective = (type, fallback) => {
    const f = findPh(type);
    if (f) return phStyle(f.p, masterPh(m.ph, f.p), f.l.ctx);
    const mp = m.ph.find(q => KIND(q.type) === KIND(type));
    return mp ? phStyle(mp, null, ctx) : fallback;
  };
  const T = (() => { const mp = m.ph.find(q => KIND(q.type) === 'title'); return mp ? phStyle(mp, null, ctx) : ctx.textStyles.title; })();
  const B = (() => { const mp = m.ph.find(q => q.type === 'body') || m.ph.find(q => KIND(q.type) === 'body'); return mp ? phStyle(mp, null, ctx) : ctx.textStyles.body; })();
  const lh = st => r2(Math.max(1, 1.2 * (st.lnSpc || 1)));
  const klass = (st, fontDefault, colorDefault, sizeDefault) => ({
    size: st.sz ? r1(st.sz * ctx.ptPx) : sizeDefault, weight: st.b ? 700 : 400, lh: lh(st), cap: st.cap,
    font: fontCss(st.font, ctx) || fontDefault, color: css(st.color) || colorDefault,
  });
  const cls = {};
  cls.h2 = klass(T, 'var(--font-heading)', 'var(--fg)');
  cls.body = klass(B, 'var(--font)', null);
  const C = effective('ctrTitle', null);
  cls.h1 = C ? klass(C, 'var(--font-heading)', 'var(--fg)') : { ...cls.h2, size: r1(cls.h2.size * 1.3) };
  const S = effective('subTitle', null);
  cls.lead = S ? klass(S, 'var(--font)', 'var(--muted)') : { ...cls.body, size: r1(cls.body.size * 1.1), color: 'var(--muted)' };
  const F = effective('sldNum', null) || effective('ftr', null);
  cls.small = F ? klass(F, 'var(--font)', 'var(--muted)') : { ...cls.body, size: r1(cls.body.size * 0.66), color: 'var(--muted)' };
  if (!F) cls.small.lh = 1.3;
  cls.hero = r1(Math.max(cls.h1.size * 1.25, cls.h1.size + 20));
  cls.h3 = r1((cls.h2.size + cls.body.size) / 2);
  const list = { char: bulletChar(B.bullet), color: css(B.buClr), gap: Math.round(B.spcBef ? B.spcBef * ctx.ptPx : cls.body.size * 0.5) };

  // Layout slides and their backgrounds.
  const rules = [], sections = [];
  for (const l of layouts) {
    const used = new Set();
    const items = l.tree.ph.map(ph => {
      try { return placeholderHTML(ph, masterPh(m.ph, ph), l.ctx, cls, used, l.type); }
      catch (e) { ctx.warn(`Skipped a placeholder on "${l.name}": ${e.message}`); return ''; }
    }).filter(Boolean);
    const ownBg = background(l.cSld, l.part, l.ctx);
    const ownLayers = decorations(l.tree.deco, l.ctx, `layout-${l.key}`);
    const showMaster = l.x.attrs.showMasterSp !== '0';
    if (ownBg || ownLayers.length || !showMaster || l.ovr) {
      const decl = [];
      if (l.ovr) {
        const r = n => l.ctx.scheme[l.ctx.map[n]] || '000000';
        decl.push(`--bg: #${r('bg1')}; --fg: #${r('tx1')}; --bg-2: #${r('bg2')}; --fg-2: #${r('tx2')}; --muted: #${mix(r('tx1'), r('bg1'), 0.6)}; --line: #${mix(r('tx1'), r('bg1'), 0.15)};`);
      }
      // The master's layers are reused through var(--master) so each image appears (and is inlined) once.
      const layers = [...ownLayers].reverse().concat(showMaster && masterLayers.length ? ['var(--master)'] : []);
      decl.push(`background: ${layers.concat(ownBg || 'var(--master-bg)').join(',\n    ')};`);
      rules.push(`  .slide[data-layout="${l.key}"] {\n    ${decl.join('\n    ')} }`);
    }
    sections.push(`<!-- ===== Slide ${sections.length + 1} · ${l.key} ===== -->\n<section class="slide" id="${l.key}" data-layout="${l.key}" data-title="${esc(l.name)}">\n${items.map(i => '  ' + i).join('\n')}${items.length ? '\n' : ''}  <aside class="notes"><p>Layout “${esc(l.name)}”.</p></aside>\n</section>`);
  }
  if (!sections.length) sections.push(`<!-- ===== Slide 1 · blank ===== -->\n<section class="slide" id="blank" data-layout="blank" data-title="Blank">\n  <aside class="notes"><p></p></aside>\n</section>`);

  const fontsUsed = [...new Set([ctx.fonts.major, ctx.fonts.minor].filter(Boolean))];
  const masterCss = [
    masterLayers.length ? `--master: ${[...masterLayers].reverse().join(',\n      ')};` : null,
    `--master-bg: ${masterBg || 'var(--bg)'};`,
    `background: ${masterLayers.length ? 'var(--master), ' : ''}var(--master-bg);`,
  ].filter(Boolean).join('\n    ');
  const styles = stylesheet({ tokens, cls, list, master: masterCss, layouts: rules, source: source.replace(/\*\//g, ''), W, H, fonts: fontsUsed });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Imported from ${esc(source)}">
<link rel="stylesheet" href="../../runtime/deck.css">
<style id="deck-style">${styles}</style>
</head>
<body>
<div class="stage" data-width="${W}" data-height="${H}">
<!-- ==================== SLIDES ==================== -->

${sections.join('\n\n')}

<!-- ==================== END SLIDES ==================== -->
</div>
<script src="../../runtime/deck.js"></script>
<script src="animations.js"></script>
</body>
</html>
`;
  fs.writeFileSync(path.join(dir, 'deck.html'), html);

  if (masters.length > 1) ctx.warn(`The file has ${masters.length} slide masters; this template uses the main one.`);
  if (ctx.stats.approximated) ctx.warn(`${ctx.stats.approximated} decorative shape${ctx.stats.approximated === 1 ? ' was' : 's were'} drawn as rectangles (unusual shape types).`);
  const embedded = kids(kid(pres, 'p:embeddedFontLst'), 'p:embeddedFont').map(f => kid(f, 'p:font')?.attrs.typeface).filter(Boolean);
  if (embedded.length) ctx.warn(`The file embeds the font${embedded.length > 1 ? 's' : ''} ${embedded.join(', ')}; add the font files to assets/ to use ${embedded.length > 1 ? 'them' : 'it'} offline.`);
  return {
    size: `${W} × ${H}`,
    layouts: layouts.map(l => ({ key: l.key, name: l.name })),
    colors: Object.fromEntries(Object.entries(tokens).filter(([key]) => /^--(bg|fg|accent|fg-2|bg-2)/.test(key))),
    fonts: fontsUsed,
    images: [...ctx.media.values()].filter(Boolean).length,
    slides: slides.length,
    dark: luminance(role('bg1')) < 0.4,
    warnings: ctx.warnings,
  };
}
