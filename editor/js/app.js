// Editor state, persistence, undo history and the two deck frames (main canvas and slide list).
// The deck files on disk are the single source of truth: every edit is applied to the live DOM in the
// canvas frame, serialized back into deck.html (between the SLIDES markers) and saved immediately.

export const SLIDES_START = '<!-- ==================== SLIDES ==================== -->';
export const SLIDES_END = '<!-- ==================== END SLIDES ==================== -->';

export const app = {
  deck: null,          // what is open: a deck name (decks/<name>) or templates/<name>
  kind: 'deck',        // 'deck' or 'template' (a template's slides are its layouts)
  base: '',            // URL of its folder: /decks/<name> or /templates/<name>
  html: '',            // deck.html as saved
  js: '',              // animations.js as saved
  index: 0,            // current slide
  selection: [],       // selected elements (in the canvas frame)
  editing: null,       // element whose text is being edited
  frame: null, win: null, doc: null,       // canvas frame
  thumbs: null, tdoc: null,                // slide list frame
  history: [], future: [],
  busy: false,         // Claude is working
  clipboard: null,
  _ev: {},
  on(ev, fn) { (this._ev[ev] ||= []).push(fn); },
  emit(ev, ...a) { (this._ev[ev] || []).forEach(fn => fn(...a)); },
};

export const $ = (sel, root = document) => root.querySelector(sel);
// Query string naming what is open, for API calls.
export const deckQuery = () => `deck=${encodeURIComponent(app.deck)}`;
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ── Server ── */

export const api = {
  async get(path) { const r = await fetch(path); if (!r.ok) throw new Error((await r.json()).error || r.statusText); return r.json(); },
  async send(method, path, body, raw = false) {
    const r = await fetch(path, { method, headers: { 'X-Deck': '1', ...(raw ? {} : { 'Content-Type': 'application/json' }) }, body: raw ? body : JSON.stringify(body || {}) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  put(path, body) { return this.send('PUT', path, body); },
  post(path, body, raw) { return this.send('POST', path, body, raw); },
  del(path) { return this.send('DELETE', path); },
};

/**
 * An in-page dialog, styled like the editor (never the browser's alert/confirm/prompt).
 * With `input` (the initial text) it asks for a value and resolves to the trimmed text; without, it resolves to true.
 * Cancel, Escape or a click outside resolve to null.
 */
export function dialog({ title, text = '', input = null, placeholder = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dialog';
    d.innerHTML = `<form><h3></h3>${text ? '<p></p>' : ''}${input !== null ? '<input autocomplete="off" spellcheck="false">' : ''}
      <div class="dialog-btns"><button type="button" data-cancel></button><button type="submit" class="${danger ? 'danger' : 'primary'}"></button></div></form>`;
    d.querySelector('h3').textContent = title;
    if (text) d.querySelector('p').textContent = text;
    d.querySelector('[data-cancel]').textContent = cancel;
    d.querySelector('[type=submit]').textContent = ok;
    const field = d.querySelector('input');
    if (field) { field.value = input; field.placeholder = placeholder; }
    const done = v => { d.close(); d.remove(); resolve(v); };
    d.querySelector('form').onsubmit = e => {
      e.preventDefault();
      if (field && !field.value.trim()) return field.focus();
      done(field ? field.value.trim() : true);
    };
    d.querySelector('[data-cancel]').onclick = () => done(null);
    d.addEventListener('cancel', e => { e.preventDefault(); done(null); }); // Escape
    d.addEventListener('mousedown', e => { if (e.target === d) done(null); }); // outside the box
    document.body.append(d);
    d.showModal();
    // Focus the field; for a destructive question, Cancel (so Enter never deletes by accident).
    if (field) { field.focus(); field.select(); } else d.querySelector(danger ? '[data-cancel]' : '[type=submit]').focus();
  });
}

export function toast(html, ms = 3500) {
  const t = $('#toast');
  t.innerHTML = html; t.hidden = false;
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ── Slides and elements ── */

export const slides = () => (app.doc ? [...app.doc.querySelectorAll('.stage > .slide')] : []);
export const currentSlide = () => slides()[app.index];
export const deckSize = () => {
  const st = app.doc && app.doc.querySelector('.stage');
  return { w: +(st?.dataset.width || 1920), h: +(st?.dataset.height || 1080) };
};
export const isObject = el => el && el.nodeType === 1 && !el.matches('.notes, script, style, template');

// Selector for an element, relative to its slide (used for Claude's context and to restore the selection).
export function selectorFor(el) {
  const slide = el.closest('.slide');
  const parts = [];
  for (let n = el; n && n !== slide; n = n.parentElement) {
    if (n.dataset.el) { parts.unshift(`[data-el="${n.dataset.el}"]`); break; }
    if (n.id && n.ownerDocument.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
    const same = [...n.parentElement.children].filter(c => c.tagName === n.tagName);
    parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(n) + 1})` : ''));
  }
  const first = parts[0] || '';
  return (first.startsWith('[') || first.startsWith('#') ? '' : ':scope > ') + parts.join(' > ');
}
export function resolveSelector(slide, sel) {
  try { return slide.querySelector(sel); } catch { return null; }
}

/* ── Serialization ── */

function strip(el) {
  [...el.classList].filter(k => k.startsWith('is-')).forEach(k => el.classList.remove(k));
  if (el.getAttribute('class') === '') el.removeAttribute('class');
  el.removeAttribute('contenteditable');
  el.removeAttribute('spellcheck');
  if (el.getAttribute('style') === '') el.removeAttribute('style');
}
export function cleanHTML(el) {
  const c = el.cloneNode(true);
  strip(c);
  c.querySelectorAll('*').forEach(strip);
  return c.outerHTML;
}

// Makes sure deck.html has the SLIDES markers (older or hand-written decks may lack them).
export function ensureMarkers(html) {
  if (html.includes(SLIDES_START) && html.includes(SLIDES_END)) return html;
  const open = /<div\b[^>]*class="[^"]*\bstage\b[^"]*"[^>]*>/i.exec(html);
  if (!open) return html;
  const startAt = open.index + open[0].length;
  const scriptAt = html.indexOf('<script', startAt);
  const endAt = html.lastIndexOf('</div>', scriptAt < 0 ? html.length : scriptAt);
  return html.slice(0, startAt) + '\n' + SLIDES_START + '\n' + html.slice(startAt, endAt).trim() + '\n' + SLIDES_END + '\n' + html.slice(endAt);
}

export function serialize() {
  const parts = slides().map((s, i) => `<!-- ===== Slide ${i + 1} · ${s.id || 'untitled'} ===== -->\n${cleanHTML(s)}`);
  const region = `${SLIDES_START}\n\n${parts.join('\n\n')}\n\n${SLIDES_END}`;
  const html = ensureMarkers(app.html);
  const a = html.indexOf(SLIDES_START), b = html.indexOf(SLIDES_END);
  if (a < 0 || b < 0) throw new Error('deck.html has no SLIDES markers');
  return html.slice(0, a) + region + html.slice(b + SLIDES_END.length);
}

/* ── Saving and history ── */

let saving = Promise.resolve();
function setSaveState(text, err) { const s = $('#save-state'); s.textContent = text; s.classList.toggle('err', !!err); }

export function save(files = { html: app.html }) {
  setSaveState('Saving…');
  saving = saving.then(() => api.put(`/api/deck?${deckQuery()}`, files))
    .then(() => setSaveState('Saved'), e => setSaveState('Not saved: ' + e.message, true));
  return saving;
}
export const flush = () => saving;

// Records the canvas DOM as the new state of the deck. Returns true when something changed.
export function commit(label = 'Edit') {
  if (!app.doc) return false;
  let html;
  try { html = serialize(); } catch (e) { toast(e.message); return false; }
  if (html === app.html) return false;
  app.history.push({ html: app.html, js: app.js, label });
  if (app.history.length > 300) app.history.shift();
  app.future = [];
  app.html = html;
  save();
  app.emit('change', label);
  return true;
}

// Replaces the whole deck (undo, redo, Claude, outside edits) and refreshes the frames.
export async function replaceDeck(next, { record = false, write = true, label = 'Change' } = {}) {
  const prev = { html: app.html, js: app.js };
  if (record) { app.history.push({ ...prev, label }); app.future = []; }
  const sel = app.selection.map(selectorFor);
  const slideId = currentSlide()?.id;
  app.html = next.html; app.js = next.js;
  if (write) await save({ html: app.html, js: app.js });
  const headSame = outside(prev.html) === outside(next.html) && prev.js === next.js;
  if (headSame && app.doc) patchSlides();
  else await loadFrames();
  const all = slides();
  const k = all.findIndex(s => s.id === slideId);
  showSlide(k >= 0 ? k : Math.min(app.index, all.length - 1), { keep: true });
  const s = currentSlide();
  setSelection(s ? sel.map(q => resolveSelector(s, q)).filter(Boolean) : []);
  app.emit('change', label);
}

const outside = html => {
  const a = html.indexOf(SLIDES_START), b = html.indexOf(SLIDES_END);
  return a < 0 || b < 0 ? html : html.slice(0, a) + html.slice(b);
};

// Swaps the canvas's slides for the ones in app.html without reloading the frame (no flicker).
function patchSlides() {
  const parsed = new DOMParser().parseFromString(app.html, 'text/html');
  const stage = app.doc.querySelector('.stage');
  stage.querySelectorAll(':scope > .slide').forEach(s => s.remove());
  const anchor = [...stage.childNodes].find(n => n.nodeType === 8 && n.data.includes('END SLIDES')) || null;
  parsed.querySelectorAll('.stage > .slide').forEach(s => stage.insertBefore(app.doc.importNode(s, true), anchor));
  syncThumbs(true);
}

export async function undo() {
  const h = app.history.pop();
  if (!h) return;
  app.future.push({ html: app.html, js: app.js, label: h.label });
  await replaceDeck(h, { label: 'Undo ' + h.label });
}
export async function redo() {
  const f = app.future.pop();
  if (!f) return;
  app.history.push({ html: app.html, js: app.js, label: f.label });
  await replaceDeck(f, { label: 'Redo ' + f.label });
}

/* ── Selection and slides ── */

export function setSelection(els) {
  app.selection = [...new Set(els.filter(isObject))];
  app.emit('select');
}

export function showSlide(i, { keep = false } = {}) {
  const all = slides();
  if (!all.length) return;
  app.index = Math.max(0, Math.min(all.length - 1, i));
  if (app.win && app.win.Deck && app.win.Deck.show) app.win.Deck.show(app.index);
  if (!keep) setSelection([]);
  if (app.tdoc) {
    const ts = [...app.tdoc.querySelectorAll('.stage > .slide')];
    ts.forEach((s, k) => s.classList.toggle('is-current', k === app.index));
    const t = ts[app.index];
    if (t) {
      const r = t.getBoundingClientRect(), vh = app.thumbs.clientHeight;
      if (r.top < 0 || r.bottom > vh) t.scrollIntoView({ block: 'nearest' });
    }
  }
  app.emit('slide');
}

/* ── Frames ── */

const frameURL = extra => `${app.base}/deck.html?edit${extra}&v=${Date.now()}`;

function loadFrame(iframe, url) {
  return new Promise(resolve => {
    iframe.onload = () => {
      const win = iframe.contentWindow;
      const ready = () => resolve(win);
      if (win.Deck && win.Deck.mode) ready();
      else win.document.addEventListener('deck:ready', ready, { once: true });
      setTimeout(ready, 1500); // a deck with a broken script still opens
    };
    iframe.src = url;
  });
}

const EDIT_CSS = `
  :root { color-scheme: dark; }
  html, body { background: transparent !important; }
  body.is-editing .slide.is-current * { pointer-events: auto !important; }
  body.is-editing .slide.is-current [data-lock], body.is-editing .slide.is-current [data-lock] * { pointer-events: none !important; }
  body.is-editing .stage { box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 20px 60px rgba(0,0,0,.45); }
`;

export async function loadFrames() {
  const [win, twin] = await Promise.all([
    loadFrame(app.frame, frameURL('') + `#${app.index + 1}`),
    loadFrame(app.thumbs, frameURL('&thumbs')),
  ]);
  app.win = win; app.doc = win.document;
  app.tdoc = twin.document;
  const st = app.doc.createElement('style');
  st.textContent = EDIT_CSS;
  app.doc.head.append(st);
  // Videos stay still while editing.
  [app.doc, app.tdoc].forEach(d => d.addEventListener('play', e => e.target.pause(), true));
  const ts = app.tdoc.createElement('style');
  ts.textContent = ':root { color-scheme: dark; } html, body { background: transparent !important; }';
  app.tdoc.head.append(ts);
  fitThumbs();
  app.emit('frame');
}

export function fitThumbs() {
  if (!app.tdoc) return;
  const w = app.thumbs.clientWidth - 30;
  app.tdoc.documentElement.style.setProperty('--thumb-zoom', (w / deckSize().w).toFixed(4));
}

// Mirrors the canvas into the slide list: the current slide only, or all slides after structural changes.
export function syncThumbs(all = false) {
  if (!app.tdoc || !app.doc) return;
  const tstage = app.tdoc.querySelector('.stage');
  const src = slides();
  const clone = s => { const c = app.tdoc.importNode(s, true); c.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable')); return c; };
  const ts = [...tstage.querySelectorAll(':scope > .slide')];
  if (all || ts.length !== src.length) {
    ts.forEach(t => t.remove());
    const anchor = [...tstage.childNodes].find(n => n.nodeType === 8 && n.data.includes('END SLIDES')) || null;
    src.forEach(s => tstage.insertBefore(clone(s), anchor));
  } else {
    const t = ts[app.index], s = src[app.index];
    if (t && s) t.replaceWith(clone(s));
  }
  [...tstage.querySelectorAll(':scope > .slide')].forEach((s, k) => s.classList.toggle('is-current', k === app.index));
}
