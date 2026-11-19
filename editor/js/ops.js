// Editing commands: insert, delete, duplicate, clipboard, align, distribute, layer order, slide operations.
import { app, commit, currentSlide, slides, setSelection, showSlide, syncThumbs, deckSize, cleanHTML, isObject } from './app.js';
import { boxOf, union, prepare, startTextEdit, stopTextEdit, uniqueName, placeBeforeNotes, topLevel, draw } from './canvas.js';

const roots = () => app.selection.filter(el => el.isConnected && !app.selection.some(o => o !== el && o.contains(el)));

/* ── Insert ── */

function make(html, name) {
  const t = app.doc.createElement('template');
  t.innerHTML = html.trim();
  const el = t.content.firstElementChild;
  if (name) el.dataset.el = uniqueName(name);
  placeBeforeNotes(el);
  return el;
}

export function insertText(kind = 'text') {
  const { w } = deckSize();
  const el = kind === 'heading'
    ? make(`<h2 class="h2" style="position:absolute;left:${(w - 1200) / 2}px;top:140px;width:1200px">Heading</h2>`, 'heading')
    : make(`<p class="body" style="position:absolute;left:${(w - 900) / 2}px;top:460px;width:900px">Text</p>`, 'text');
  commit('Insert text');
  startTextEdit(el, null, null, true);
}

const SHAPES = {
  rect: 'background:var(--accent);',
  round: 'background:var(--accent);border-radius:32px;',
  ellipse: 'background:var(--accent);border-radius:50%;',
  line: 'background:var(--fg, #fff);height:4px;border-radius:2px;',
};
export function insertShape(kind) {
  const { w, h } = deckSize();
  const el = kind === 'card'
    ? make(`<div class="card" style="position:absolute;left:${w / 2 - 300}px;top:${h / 2 - 200}px;width:600px;height:400px"></div>`, 'card')
    : make(`<div style="position:absolute;left:${w / 2 - 200}px;top:${h / 2 - (kind === 'line' ? 2 : 200)}px;width:400px;${kind === 'line' ? '' : 'height:400px;'}${SHAPES[kind]}"></div>`, kind === 'line' ? 'line' : 'shape');
  commit('Insert shape');
  setSelection([el]);
}

/* ── Delete, duplicate, clipboard ── */

export function deleteSelection() {
  const r = roots();
  if (!r.length) return;
  r.forEach(el => el.remove());
  setSelection([]);
  commit('Delete');
}

function cloneInto(html, dx = 24, dy = 24) {
  const t = app.doc.createElement('template');
  t.innerHTML = html;
  const el = t.content.firstElementChild;
  if (!el) return null;
  el.removeAttribute('id');
  if (el.dataset.el) el.dataset.el = uniqueName(el.dataset.el.replace(/-\d+$/, ''));
  el.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
  if (el.style.left) el.style.left = Math.round(parseFloat(el.style.left) + dx) + 'px';
  if (el.style.top) el.style.top = Math.round(parseFloat(el.style.top) + dy) + 'px';
  return el;
}

export function duplicate() {
  const r = roots();
  if (!r.length) return;
  const made = r.map(el => { const c = cloneInto(cleanHTML(el)); el.after(c); return c; });
  commit('Duplicate');
  setSelection(made);
}

export function copy(cut = false) {
  const r = roots();
  if (!r.length) return false;
  app.clipboard = r.map(cleanHTML);
  try { navigator.clipboard.writeText(app.clipboard.join('\n')); } catch { /* not allowed: internal clipboard still works */ }
  if (cut) deleteSelection();
  return true;
}

export function paste() {
  if (!app.clipboard) return false;
  const made = app.clipboard.map(h => { const el = cloneInto(h); placeBeforeNotes(el); return el; });
  commit('Paste');
  setSelection(made);
  return true;
}

export function selectAll() { setSelection(topLevel()); }

/* ── Move, align, distribute ── */

export function nudge(dx, dy) {
  const r = roots();
  if (!r.length) return;
  r.forEach(el => { const s = prepare(el); el.style.left = Math.round(s.left + dx) + 'px'; el.style.top = Math.round(s.top + dy) + 'px'; });
  clearTimeout(nudge.t);
  draw();
  nudge.t = setTimeout(() => commit('Nudge'), 400); // one undo step per burst of arrow keys
}

function shift(el, dx, dy) {
  const s = prepare(el);
  el.style.left = Math.round(s.left + dx) + 'px';
  el.style.top = Math.round(s.top + dy) + 'px';
}

export function align(kind) {
  const r = roots();
  if (!r.length) return;
  const { w, h } = deckSize();
  const target = r.length > 1 ? union(r.map(boxOf)) : { x: 0, y: 0, w, h };
  r.forEach(el => {
    const b = boxOf(el);
    const dx = { left: target.x - b.x, center: target.x + target.w / 2 - (b.x + b.w / 2), right: target.x + target.w - (b.x + b.w) }[kind] || 0;
    const dy = { top: target.y - b.y, middle: target.y + target.h / 2 - (b.y + b.h / 2), bottom: target.y + target.h - (b.y + b.h) }[kind] || 0;
    shift(el, dx, dy);
  });
  commit('Align');
}

export function distribute(axis) {
  const r = roots();
  if (r.length < 3) return;
  const X = axis === 'h';
  const items = r.map(el => ({ el, b: boxOf(el) })).sort((a, b) => (X ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = items[0].b, last = items[items.length - 1].b;
  const total = items.reduce((s, i) => s + (X ? i.b.w : i.b.h), 0);
  const gap = ((X ? last.x + last.w - first.x : last.y + last.h - first.y) - total) / (items.length - 1);
  let pos = X ? first.x : first.y;
  items.forEach(({ el, b }) => {
    shift(el, X ? pos - b.x : 0, X ? 0 : pos - b.y);
    pos += (X ? b.w : b.h) + gap;
  });
  commit('Distribute');
}

/* ── Layer order (DOM order = stacking order) ── */

export function order(kind) {
  const r = roots();
  if (!r.length) return;
  r.forEach(el => {
    const p = el.parentElement;
    const sibs = [...p.children].filter(isObject);
    const i = sibs.indexOf(el);
    if (kind === 'front') p.insertBefore(el, p.querySelector(':scope > .notes'));
    if (kind === 'back') p.insertBefore(el, sibs[0]);
    if (kind === 'forward' && sibs[i + 1]) sibs[i + 1].after(el);
    if (kind === 'backward' && sibs[i - 1]) sibs[i - 1].before(el);
  });
  commit('Arrange');
  draw();
}

/* ── Slides ── */

const LAYOUTS = {
  blank: '',
  title: `
  <h1 class="hero center" data-el="title" data-anim="words" style="position:absolute;left:160px;top:400px;width:1600px">Title</h1>
  <p class="lead center" data-el="subtitle" data-anim="rise" data-delay="0.4" style="position:absolute;left:360px;top:600px;width:1200px">Subtitle</p>`,
  text: `
  <h2 class="h2" data-el="title" data-anim="rise" style="position:absolute;left:140px;top:120px;width:1640px">Title</h2>
  <p class="body" data-el="text" data-anim="rise" data-delay="0.2" style="position:absolute;left:140px;top:300px;width:1200px">Text</p>`,
  bullets: `
  <h2 class="h2" data-el="title" data-anim="rise" style="position:absolute;left:140px;top:120px;width:1640px">Title</h2>
  <ul class="list" data-el="bullets" style="position:absolute;left:140px;top:320px;width:1300px">
    <li data-anim="left" data-step="1">First point</li>
    <li data-anim="left" data-step="2">Second point</li>
    <li data-anim="left" data-step="3">Third point</li>
  </ul>`,
  image: `
  <h2 class="h2" data-el="title" data-anim="rise" style="position:absolute;left:140px;top:120px;width:760px">Title</h2>
  <p class="body muted" data-el="text" data-anim="rise" data-delay="0.2" style="position:absolute;left:140px;top:300px;width:700px">Drop an image onto the slide, or ask Claude.</p>
  <div class="card" data-el="image" data-anim="zoom" data-delay="0.3" style="position:absolute;left:960px;top:140px;width:820px;height:800px"></div>`,
  stat: `
  <p class="eyebrow" data-el="label" data-anim="fade" style="position:absolute;left:140px;top:300px;width:1200px">Label</p>
  <p class="stat accent" data-el="number" data-anim="count" style="position:absolute;left:140px;top:380px;width:1400px">42 %</p>
  <p class="lead" data-el="caption" data-anim="rise" data-delay="0.4" style="position:absolute;left:140px;top:600px;width:1200px">What the number means</p>`,
};

function uniqueSlideId(base) {
  const taken = new Set(slides().map(s => s.id));
  let id = base, i = 1;
  while (taken.has(id)) id = `${base}-${++i}`;
  return id;
}

function insertSlide(s, label) {
  const cur = currentSlide();
  if (cur) cur.after(s); else app.doc.querySelector('.stage').append(s);
  commit(label);
  syncThumbs(true);
  showSlide(app.index + (cur ? 1 : 0));
}

// A simple built-in layout. In a template, the new slide is a new layout: it gets a key (data-layout) and a name.
export function addSlide(layout = 'blank', name = 'New slide') {
  const s = app.doc.createElement('section');
  s.className = 'slide';
  if (app.kind === 'template') {
    s.id = uniqueSlideId(layout === 'blank' ? 'layout' : layout);
    s.dataset.layout = s.id;
    s.dataset.title = name;
  } else {
    s.id = uniqueSlideId('slide-' + (slides().length + 1));
    s.dataset.title = 'New slide';
  }
  s.innerHTML = `${LAYOUTS[layout] || ''}\n  <aside class="notes"><p></p></aside>\n`;
  insertSlide(s, app.kind === 'template' ? 'New layout' : 'New slide');
}

/** The layouts this deck offers (from its template), parsed from <template id="deck-layouts"> in deck.html. */
export function deckLayouts() {
  const m = /<template id="deck-layouts">([\s\S]*?)<\/template>/.exec(app.html);
  if (!m) return [];
  const t = app.doc.createElement('template');
  t.innerHTML = m[1];
  return [...t.content.querySelectorAll('section.slide')].map(s => ({ title: s.dataset.title || s.id || 'Layout', section: s }));
}

// A new slide from one of the deck's layouts: same design (data-layout) and placeholders, fresh id and notes.
export function addSlideFromLayout(i) {
  const l = deckLayouts()[i];
  if (!l) return;
  const s = app.doc.importNode(l.section, true);
  s.id = uniqueSlideId('slide-' + (slides().length + 1));
  s.dataset.title = 'New slide';
  let notes = s.querySelector(':scope > .notes');
  if (!notes) { notes = app.doc.createElement('aside'); notes.className = 'notes'; s.append(notes); }
  notes.innerHTML = '<p></p>';
  insertSlide(s, 'New slide');
}

export function duplicateSlide() {
  const cur = currentSlide();
  if (!cur) return;
  const t = app.doc.createElement('template');
  t.innerHTML = cleanHTML(cur);
  const s = t.content.firstElementChild;
  s.id = uniqueSlideId(cur.id.replace(/-copy(-\d+)?$/, '') + '-copy');
  cur.after(s);
  commit('Duplicate slide');
  syncThumbs(true);
  showSlide(app.index + 1);
}

export function deleteSlide() {
  const all = slides();
  if (all.length <= 1) return;
  all[app.index].remove();
  commit('Delete slide');
  syncThumbs(true);
  showSlide(Math.min(app.index, all.length - 2));
}

export function moveSlide(from, to) {
  const all = slides();
  if (from === to || from < 0 || to < 0 || from >= all.length || to > all.length) return;
  const s = all[from];
  if (to >= all.length) all[all.length - 1].after(s);
  else all[to].before(s);
  commit('Reorder slides');
  syncThumbs(true);
  showSlide(slides().indexOf(s));
}

export { stopTextEdit };
