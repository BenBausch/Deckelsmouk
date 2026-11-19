// Direct manipulation on the slide: select, move, resize, snap, marquee, edit text, drop files.
import { app, $, commit, currentSlide, setSelection, isObject, deckSize, toast, deckQuery } from './app.js';
import { paste } from './ops.js';

const SNAP_PX = 7;           // snapping distance in screen pixels
const DRAG_THRESHOLD = 3;
let overlay, viewport, hoverEl = null, guides = [], marquee = null;

export function initCanvas() {
  overlay = $('#overlay');
  viewport = $('#viewport');
  overlay.addEventListener('pointerdown', onHandleDown);
  new ResizeObserver(() => { app.win?.Deck?.fit?.(); draw(); }).observe(viewport);
  app.on('select', draw);
  app.on('slide', draw);
  app.on('change', draw);
}

// Called every time the canvas frame (re)loads.
export function attachCanvas() {
  const doc = app.doc;
  doc.addEventListener('pointerdown', onDown);
  doc.addEventListener('pointermove', onHover);
  doc.addEventListener('pointerleave', () => { hoverEl = null; draw(); });
  doc.addEventListener('dblclick', onDblClick);
  doc.addEventListener('paste', onPaste);
  doc.addEventListener('dragover', e => { e.preventDefault(); });
  doc.addEventListener('drop', onDrop);
  app.win.addEventListener('resize', () => requestAnimationFrame(draw));
  draw();
}

/* ── Geometry ── */

const scale = () => (app.win && app.win.Deck && app.win.Deck.scale) || 1;
const frameOffset = () => ({ x: app.frame.offsetLeft, y: app.frame.offsetTop });

// Box of an element in stage pixels, relative to the current slide.
export function boxOf(el) {
  const s = currentSlide().getBoundingClientRect(), r = el.getBoundingClientRect(), k = scale();
  return { x: (r.left - s.left) / k, y: (r.top - s.top) / k, w: r.width / k, h: r.height / k };
}
const union = boxes => {
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};
// Stage box -> overlay pixels.
function toOverlay(b) {
  const s = currentSlide().getBoundingClientRect(), k = scale(), o = frameOffset();
  return { x: o.x + s.left + b.x * k, y: o.y + s.top + b.y * k, w: b.w * k, h: b.h * k };
}
const topLevel = () => [...currentSlide().children].filter(isObject);

/* ── Drawing the overlay ── */

function div(cls, b, parent = overlay) {
  const d = document.createElement('div');
  d.className = cls;
  if (b) Object.assign(d.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
  parent.append(d);
  return d;
}

export function draw() {
  if (!overlay) return;
  overlay.replaceChildren();
  if (!app.doc || !currentSlide()) return;
  const sel = app.selection.filter(el => el.isConnected);
  if (hoverEl && hoverEl.isConnected && !sel.includes(hoverEl)) div('hover-box', toOverlay(boxOf(hoverEl)));
  // Step badges for animated top-level objects.
  topLevel().forEach(el => {
    const st = el.dataset.step || [...el.querySelectorAll('[data-step]')].map(e => e.dataset.step).sort()[0];
    if (!st || st === '0') return;
    const b = toOverlay(boxOf(el));
    const d = div('step-badge'); d.style.left = b.x + 'px'; d.style.top = b.y + 'px'; d.textContent = st;
  });
  sel.forEach(el => {
    const b = toOverlay(boxOf(el));
    div('sel-box' + (sel.length > 1 ? ' multi' : '') + (app.editing === el ? ' editing' : ''), b);
  });
  if (sel.length === 1 && app.editing !== sel[0]) {
    const el = sel[0], bs = boxOf(el), b = toOverlay(bs);
    const label = div('sel-label');
    label.style.left = b.x + 'px'; label.style.top = b.y + 'px';
    label.textContent = `${el.dataset.el || el.tagName.toLowerCase()}  ${Math.round(bs.w)}×${Math.round(bs.h)}`;
    const H = { nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5] };
    for (const [h, [fx, fy]] of Object.entries(H)) {
      const d = div('handle');
      d.dataset.h = h;
      d.style.left = b.x + b.w * fx + 'px'; d.style.top = b.y + b.h * fy + 'px';
    }
  } else if (sel.length > 1) {
    const b = toOverlay(union(sel.map(boxOf)));
    const d = div('sel-box', b); d.style.borderStyle = 'dotted'; d.style.borderColor = 'rgba(255,255,255,.4)';
  }
  guides.forEach(g => {
    const k = scale(), s = currentSlide().getBoundingClientRect(), o = frameOffset();
    if (g.axis === 'x') div('guide v', { x: o.x + s.left + g.at * k, y: o.y + s.top, w: 1, h: s.height });
    else div('guide h', { x: o.x + s.left, y: o.y + s.top + g.at * k, w: s.width, h: 1 });
  });
  if (marquee) div('marquee', toOverlay(marquee));
}

/* ── Picking ── */

function elementAt(target) {
  const slide = currentSlide();
  if (!slide || !target || target.nodeType !== 1 || !slide.contains(target) || target === slide) return null;
  return target;
}
const topOf = el => { const slide = currentSlide(); while (el.parentElement && el.parentElement !== slide) el = el.parentElement; return el; };
const svgRoot = el => { const s = el.closest('svg'); return s && currentSlide().contains(s) ? s : el; };

/* ── Pointer: select and move ── */

function onHover(e) {
  if (e.buttons || app.editing) return;
  const t = elementAt(e.target);
  const next = t ? (e.altKey ? t : pickFor(t)) : null;
  if (next !== hoverEl) { hoverEl = next; draw(); }
}
// What a click on t selects: the top-level object, or one level deeper inside the current selection.
function pickFor(t) {
  t = svgRoot(t);
  const inside = app.selection.find(s => s !== t && s.contains(t));
  if (inside) { let c = t; while (c.parentElement !== inside) c = c.parentElement; return c; }
  if (app.selection.includes(t)) return t;
  return topOf(t);
}

function onDown(e) {
  if (e.button !== 0) return;
  closeMenus();
  if (app.editing && app.editing.contains(e.target)) return; // caret placement while editing text
  if (app.editing) stopTextEdit();
  const t = elementAt(e.target);
  if (!t) { // background: marquee
    if (!e.shiftKey) setSelection([]);
    return startMarquee(e);
  }
  e.preventDefault();
  app.frame.focus();
  let drill = null;
  const holder = app.selection.find(s => s.contains(t));
  if (holder && !e.shiftKey && !e.altKey) {
    drill = holder !== t ? pickFor(t) : null; // a plain click (no drag) goes one level deeper
  } else {
    const obj = e.altKey || e.metaKey ? svgRoot(t) : topOf(svgRoot(t));
    if (e.shiftKey) setSelection(app.selection.includes(obj) ? app.selection.filter(x => x !== obj) : [...app.selection, obj]);
    else setSelection([obj]);
  }
  if (!app.selection.length) return;
  startMove(e, () => { if (drill) setSelection([drill]); });
}

// Makes an element movable by left/top: top-level flow elements become absolute, nested ones get a relative offset.
// Width (and height, when it came from top+bottom) is fixed so the element keeps its size.
function prepare(el, { height = false } = {}) {
  const cs = app.win.getComputedStyle(el);
  if (cs.position === 'static') {
    if (el.parentElement === currentSlide()) {
      const l = el.offsetLeft, t = el.offsetTop;
      Object.assign(el.style, { position: 'absolute', left: l + 'px', top: t + 'px', width: cs.width, margin: '0' });
    } else {
      Object.assign(el.style, { position: 'relative', left: '0px', top: '0px' });
    }
  } else if (cs.position === 'absolute' || cs.position === 'fixed') {
    const h0 = el.getBoundingClientRect().height;
    const l = cs.left, t = cs.top, w = cs.width, hh = cs.height;
    if (el.style.inset) el.style.inset = ''; // expand the shorthand before setting sides
    el.style.left = l; el.style.top = t;
    if (!el.style.width) el.style.width = w;
    // With left, top and width set, a leftover right is ignored; a bottom would stretch the height, which is fixed below.
    el.style.removeProperty('right'); el.style.removeProperty('bottom');
    if (Math.abs(el.getBoundingClientRect().height - h0) > 0.5 || height) el.style.height = hh;
  }
  if (height && !el.style.height) el.style.height = app.win.getComputedStyle(el).height;
  const now = app.win.getComputedStyle(el);
  return { el, left: parseFloat(now.left) || 0, top: parseFloat(now.top) || 0, width: parseFloat(now.width) || 0, height: parseFloat(now.height) || 0 };
}

function snapCandidates(exclude) {
  const { w, h } = deckSize();
  const xs = [0, w / 2, w], ys = [0, h / 2, h];
  topLevel().filter(el => !exclude.some(x => x === el || x.contains(el) || el.contains(x))).forEach(el => {
    const b = boxOf(el);
    if (b.w >= w - 1 && b.h >= h - 1) return;
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  });
  return { xs, ys };
}
function snap(value, sizes, lines, limit) {
  let best = null;
  for (const off of sizes) for (const L of lines) {
    const d = L - (value + off);
    if (Math.abs(d) <= limit && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: L };
  }
  return best;
}

function startMove(e, onClick) {
  const sx = e.clientX, sy = e.clientY;
  const target = e.target;
  let started = false, starts = [], box0 = null, cand = null;
  try { target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const move = ev => {
    const dxs = ev.clientX - sx, dys = ev.clientY - sy;
    if (!started) {
      if (Math.hypot(dxs, dys) < DRAG_THRESHOLD) return;
      started = true;
      // Drop nested elements whose ancestor is also selected (they move with it).
      const sel = app.selection.filter(el => !app.selection.some(o => o !== el && o.contains(el)));
      starts = sel.map(el => prepare(el));
      box0 = union(sel.map(boxOf));
      cand = snapCandidates(sel);
    }
    const k = scale();
    let dx = dxs / k, dy = dys / k;
    guides = [];
    if (!ev.altKey) {
      const lim = SNAP_PX / k;
      const gx = snap(box0.x + dx, [0, box0.w / 2, box0.w], cand.xs, lim);
      const gy = snap(box0.y + dy, [0, box0.h / 2, box0.h], cand.ys, lim);
      if (gx) { dx += gx.d; guides.push({ axis: 'x', at: gx.at }); }
      if (gy) { dy += gy.d; guides.push({ axis: 'y', at: gy.at }); }
    }
    if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    starts.forEach(s => { s.el.style.left = Math.round(s.left + dx) + 'px'; s.el.style.top = Math.round(s.top + dy) + 'px'; });
    draw();
  };
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    guides = [];
    if (started) commit('Move'); else onClick();
    draw();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

/* ── Resize handles (in the overlay, outside the frame) ── */

function onHandleDown(e) {
  const h = e.target.dataset && e.target.dataset.h;
  if (!h || app.selection.length !== 1) return;
  e.preventDefault();
  const el = app.selection[0];
  const s = prepare(el, { height: /n|s/.test(h) });
  const media = el.matches('img, video, svg, canvas, picture');
  const ratio = s.width / (s.height || 1);
  const sx = e.clientX, sy = e.clientY;
  viewport.classList.add('dragging');
  e.target.setPointerCapture(e.pointerId);
  const move = ev => {
    const k = scale();
    let dx = (ev.clientX - sx) / k, dy = (ev.clientY - sy) / k;
    let w = s.width, hh = s.height, l = s.left, t = s.top;
    if (h.includes('e')) w = s.width + dx;
    if (h.includes('w')) w = s.width - dx;
    if (h.includes('s')) hh = s.height + dy;
    if (h.includes('n')) hh = s.height - dy;
    const keep = (media && h.length === 2) !== ev.shiftKey;
    if (keep && h.length === 2) {
      if (Math.abs(w / s.width) > Math.abs(hh / s.height)) hh = w / ratio; else w = hh * ratio;
    } else if (keep && media) {
      if (h === 'e' || h === 'w') hh = w / ratio; else w = hh * ratio;
    }
    w = Math.max(8, w); hh = Math.max(8, hh);
    if (h.includes('w')) l = s.left + (s.width - w);
    if (h.includes('n')) t = s.top + (s.height - hh);
    el.style.width = Math.round(w) + 'px';
    if (/n|s/.test(h) || keep || el.style.height) el.style.height = Math.round(hh) + 'px';
    el.style.left = Math.round(l) + 'px'; el.style.top = Math.round(t) + 'px';
    draw();
  };
  const up = () => {
    e.target.removeEventListener('pointermove', move);
    e.target.removeEventListener('pointerup', up);
    viewport.classList.remove('dragging');
    commit('Resize');
  };
  e.target.addEventListener('pointermove', move);
  e.target.addEventListener('pointerup', up);
}

/* ── Marquee ── */

function startMarquee(e) {
  const slide = currentSlide();
  if (!slide) return;
  const s = slide.getBoundingClientRect(), k = scale();
  const p0 = { x: (e.clientX - s.left) / k, y: (e.clientY - s.top) / k };
  const base = e.shiftKey ? [...app.selection] : [];
  const tgt = app.doc.documentElement;
  try { tgt.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const move = ev => {
    const p = { x: (ev.clientX - s.left) / k, y: (ev.clientY - s.top) / k };
    marquee = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
    if (marquee.w < 3 && marquee.h < 3) return draw();
    const hit = topLevel().filter(el => {
      const b = boxOf(el);
      if (b.w >= deckSize().w - 1 && b.h >= deckSize().h - 1) return false; // full-slide backgrounds
      return b.x < marquee.x + marquee.w && b.x + b.w > marquee.x && b.y < marquee.y + marquee.h && b.y + b.h > marquee.y;
    });
    setSelection([...base, ...hit]);
  };
  const up = () => {
    tgt.removeEventListener('pointermove', move);
    tgt.removeEventListener('pointerup', up);
    marquee = null; draw();
  };
  tgt.addEventListener('pointermove', move);
  tgt.addEventListener('pointerup', up);
}

/* ── Text editing ── */

const INLINE = new Set(['SPAN', 'B', 'STRONG', 'I', 'EM', 'A', 'CODE', 'SMALL', 'SUP', 'SUB', 'MARK', 'U', 'S', 'BR', 'FONT']);
const NO_TEXT = 'img, video, svg, canvas, iframe, picture, audio, hr, input';

function onDblClick(e) {
  const t = elementAt(e.target);
  if (!t || t.closest(NO_TEXT)) return;
  let el = t;
  while (INLINE.has(el.tagName) && el.parentElement && el.parentElement !== currentSlide()) el = el.parentElement;
  if (!el.textContent.trim() && el.children.length) return;
  startTextEdit(el, e.clientX, e.clientY);
}

export function startTextEdit(el, x, y, selectAll = false) {
  stopTextEdit();
  app.editing = el;
  setSelection([el]);
  el.setAttribute('contenteditable', 'true');
  el.setAttribute('spellcheck', 'false');
  el.focus();
  const sel = app.win.getSelection();
  const r = !selectAll && x != null && app.doc.caretRangeFromPoint ? app.doc.caretRangeFromPoint(x, y) : null;
  sel.removeAllRanges();
  if (r) sel.addRange(r);
  else { const all = app.doc.createRange(); all.selectNodeContents(el); sel.addRange(all); }
  el.addEventListener('blur', stopTextEdit, { once: true });
  el.addEventListener('input', draw);
  draw();
}

export function stopTextEdit() {
  const el = app.editing;
  if (!el) return;
  app.editing = null;
  el.removeEventListener('input', draw);
  el.removeAttribute('contenteditable');
  el.removeAttribute('spellcheck');
  app.win.getSelection().removeAllRanges();
  commit('Edit text');
  draw();
}

export function textKey(e) {
  // Inside contentEditable: Enter makes a line break, Escape ends editing.
  if (e.key === 'Escape') { e.preventDefault(); stopTextEdit(); return true; }
  if (e.key === 'Enter' && !e.shiftKey && !/^(UL|OL|LI|DIV)$/.test(app.editing.tagName)) { e.preventDefault(); app.doc.execCommand('insertLineBreak'); return true; }
  return false;
}

/* ── Paste and drop ── */

export async function onPaste(e) {
  if (app.editing) { // plain text only, so pasted styles don't leak in
    e.preventDefault();
    app.doc.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    return;
  }
  if (app.busy || !currentSlide()) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); for (const f of files) await insertFile(f); return; }
  const text = (e.clipboardData?.getData('text/plain') || '').trim();
  e.preventDefault();
  // Our own copied objects, or plain text from elsewhere as a new text box.
  if (app.clipboard && (!text || text === app.clipboard.join('\n').trim())) return paste();
  if (!text) return;
  const { w } = deckSize();
  const p = app.doc.createElement('p');
  p.className = 'body';
  p.dataset.el = uniqueName('text');
  p.textContent = text;
  Object.assign(p.style, { position: 'absolute', left: (w - 1000) / 2 + 'px', top: '440px', width: '1000px' });
  placeBeforeNotes(p);
  commit('Paste text');
  setSelection([p]);
}

async function onDrop(e) {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length || !currentSlide()) return;
  const s = currentSlide().getBoundingClientRect(), k = scale();
  const at = { x: (e.clientX - s.left) / k, y: (e.clientY - s.top) / k };
  // Dropped on an image placeholder: the picture takes its place.
  const ph = app.doc.elementFromPoint(e.clientX, e.clientY)?.closest('.ph-image');
  for (const f of files) await insertFile(f, at, ph && ph.isConnected ? ph : null);
}

export async function upload(file) {
  const r = await fetch(`/api/upload?${deckQuery()}&name=${encodeURIComponent(file.name || 'pasted.png')}`, { method: 'POST', headers: { 'X-Deck': '1' }, body: file });
  if (!r.ok) throw new Error('Upload failed');
  return (await r.json()).path;
}

// Uploads a file into the deck's assets and places it on the slide (centred, at a drop point, or filling an image
// placeholder).
export async function insertFile(file, at, placeholder = null) {
  if (!/^(image|video)\//.test(file.type) && !/\.svg$/i.test(file.name)) return toast(`Can't insert ${file.name}: only images and videos.`);
  let src;
  try { src = await upload(file); } catch (err) { return toast(err.message); }
  const doc = app.doc, video = file.type.startsWith('video/');
  const el = doc.createElement(video ? 'video' : 'img');
  el.setAttribute('src', src);
  if (video) { el.setAttribute('muted', ''); el.setAttribute('playsinline', ''); el.setAttribute('loop', ''); el.setAttribute('autoplay', ''); }
  else el.setAttribute('alt', '');
  el.dataset.el = uniqueName(file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'media');
  const { w: W, h: H } = deckSize();
  const dims = await new Promise(res => {
    if (video) { el.addEventListener('loadedmetadata', () => res([el.videoWidth, el.videoHeight]), { once: true }); }
    else el.addEventListener('load', () => res([el.naturalWidth, el.naturalHeight]), { once: true });
    el.addEventListener('error', () => res([800, 450]), { once: true });
    setTimeout(() => res([800, 450]), 4000);
    el.style.position = 'absolute'; el.style.visibility = 'hidden';
    currentSlide().append(el);
  });
  if (placeholder && placeholder.isConnected) {
    const ps = placeholder.style, radius = app.win.getComputedStyle(placeholder).borderRadius;
    el.removeAttribute('style');
    Object.assign(el.style, { position: 'absolute', left: ps.left, top: ps.top, width: ps.width, height: ps.height, objectFit: 'cover' });
    if (radius && radius !== '0px') el.style.borderRadius = radius;
    for (const a of ['data-anim', 'data-step', 'data-delay', 'data-dur', 'data-out', 'data-out-step', 'data-magic']) {
      if (placeholder.hasAttribute(a)) el.setAttribute(a, placeholder.getAttribute(a));
    }
    placeholder.replaceWith(el);
    commit('Fill placeholder');
    setSelection([el]);
    return;
  }
  let [w, h] = dims;
  const f = Math.min(1, (W * 0.6) / w, (H * 0.6) / h);
  w = Math.round(w * f); h = Math.round(h * f);
  const x = at ? at.x - w / 2 : (W - w) / 2, y = at ? at.y - h / 2 : (H - h) / 2;
  el.removeAttribute('style');
  Object.assign(el.style, { position: 'absolute', left: Math.round(x) + 'px', top: Math.round(y) + 'px', width: w + 'px', height: h + 'px', objectFit: 'cover' });
  placeBeforeNotes(el);
  commit('Insert media');
  setSelection([el]);
}

export function uniqueName(base) {
  const taken = new Set([...currentSlide().querySelectorAll('[data-el]')].map(e => e.dataset.el));
  let n = base, i = 1;
  while (taken.has(n)) n = `${base}-${++i}`;
  return n;
}
export function placeBeforeNotes(el) {
  const slide = currentSlide();
  const notes = slide.querySelector(':scope > .notes');
  slide.insertBefore(el, notes);
}

export function setHover(el) { hoverEl = el; draw(); }
function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
export { union, topLevel, prepare, closeMenus };
