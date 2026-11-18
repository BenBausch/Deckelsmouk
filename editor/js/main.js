// Boot, deck picker, toolbar, keyboard shortcuts, slide list, live reload, preview and export.
import { app, $, $$, api, toast, loadFrames, showSlide, slides, currentSlide, undo, redo, replaceDeck, fitThumbs, setSelection, save, syncThumbs } from './app.js';
import { initCanvas, attachCanvas, insertFile, startTextEdit, stopTextEdit, textKey, onPaste, draw, closeMenus } from './canvas.js';
import * as ops from './ops.js';
import { initInspector } from './inspector.js';
import { initClaude, focusPrompt, stop as stopClaude } from './claude.js';
import { initNotes } from './notes.js';
import { initAI } from './aisettings.js';

const params = new URLSearchParams(location.search);

/* ── Picker ── */

async function picker() {
  $('#picker').hidden = false;
  const [decks, templates] = await Promise.all([api.get('/api/decks'), api.get('/api/templates')]);
  $('#template-select').innerHTML = templates.map(t => `<option>${t}</option>`).join('');
  const list = $('#deck-list');
  list.innerHTML = decks.length ? '' : '<p class="sub">No decks yet. Create one above.</p>';
  decks.forEach(d => {
    const a = document.createElement('a');
    a.className = 'deck-card';
    a.href = `/?deck=${encodeURIComponent(d.name)}`;
    a.innerHTML = `<div class="thumb"><iframe loading="lazy" tabindex="-1" src="/decks/${d.name}/deck.html?edit"></iframe></div>
      <div class="meta"><b></b><span>${d.name} · ${d.slides} slide${d.slides === 1 ? '' : 's'} · ${new Date(d.modified).toLocaleDateString()}</span></div>`;
    a.querySelector('b').textContent = d.title;
    list.append(a);
    const box = a.querySelector('.thumb'), fr = a.querySelector('iframe');
    new ResizeObserver(() => { fr.style.transform = `scale(${box.clientWidth / 1920})`; }).observe(box);
  });
  $('#new-deck').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api.post('/api/new', { name: f.get('name'), title: f.get('title'), template: f.get('template') });
      location.href = `/?deck=${encodeURIComponent(r.name)}`;
    } catch (err) { toast(err.message); }
  };
}

/* ── Editor ── */

async function open(name) {
  app.deck = name;
  $('#editor').hidden = false;
  app.frame = $('#frame');
  app.thumbs = $('#thumbs');
  const d = await api.get(`/api/deck?deck=${encodeURIComponent(name)}`);
  app.html = d.html; app.js = d.js;
  document.title = `${titleOf(app.html)} · Deckelsmouk`;
  $('#deck-title').value = titleOf(app.html);
  app.index = Math.max(0, (+params.get('slide') || 1) - 1);
  initCanvas(); initInspector(); initClaude(); initNotes();
  initAI().catch(e => toast('AI settings: ' + e.message));
  app.on('frame', onFrame);
  app.on('slide', () => history.replaceState(null, '', `/?deck=${encodeURIComponent(app.deck)}&slide=${app.index + 1}`));
  await loadFrames();
  showSlide(Math.min(app.index, slides().length - 1));
  wire();
  liveReload();
}

const titleOf = html => ((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || app.deck).trim();

function onFrame() {
  attachCanvas();
  app.doc.addEventListener('keydown', onKey);
  // Slide list: click to show, drag to reorder.
  const tdoc = app.tdoc;
  tdoc.addEventListener('keydown', onKey);
  tdoc.addEventListener('pointerdown', e => {
    const s = e.target.closest && e.target.closest('.slide');
    if (!s || e.button !== 0) return;
    e.preventDefault();
    const all = () => [...tdoc.querySelectorAll('.stage > .slide')];
    const from = all().indexOf(s), y0 = e.clientY;
    let to = null;
    const move = ev => {
      if (Math.abs(ev.clientY - y0) < 6 && to === null) return;
      all().forEach(x => x.classList.remove('is-drop-before', 'is-drop-after'));
      const list = all();
      to = list.length;
      for (let i = 0; i < list.length; i++) {
        const r = list[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { to = i; break; }
      }
      if (to < list.length) list[to].classList.add('is-drop-before'); else list[list.length - 1].classList.add('is-drop-after');
    };
    const up = () => {
      tdoc.removeEventListener('pointermove', move);
      tdoc.removeEventListener('pointerup', up);
      all().forEach(x => x.classList.remove('is-drop-before', 'is-drop-after'));
      if (to === null) { stopTextEdit(); showSlide(from); }
      else if (to !== from && to !== from + 1) ops.moveSlide(from, to);
    };
    tdoc.addEventListener('pointermove', move);
    tdoc.addEventListener('pointerup', up);
  });
}

/* ── Commands ── */

const commands = {
  undo, redo,
  'insert-text': () => ops.insertText('text'),
  'insert-heading': () => ops.insertText('heading'),
  'insert-image': () => $('#file-input').click(),
  'shape-rect': () => ops.insertShape('rect'), 'shape-round': () => ops.insertShape('round'),
  'shape-ellipse': () => ops.insertShape('ellipse'), 'shape-line': () => ops.insertShape('line'), 'shape-card': () => ops.insertShape('card'),
  'align-left': () => ops.align('left'), 'align-center': () => ops.align('center'), 'align-right': () => ops.align('right'),
  'align-top': () => ops.align('top'), 'align-middle': () => ops.align('middle'), 'align-bottom': () => ops.align('bottom'),
  'distribute-h': () => ops.distribute('h'), 'distribute-v': () => ops.distribute('v'),
  front: () => ops.order('front'), forward: () => ops.order('forward'), backward: () => ops.order('backward'), back: () => ops.order('back'),
  'slide-blank': () => ops.addSlide('blank'), 'slide-title': () => ops.addSlide('title'), 'slide-text': () => ops.addSlide('text'),
  'slide-bullets': () => ops.addSlide('bullets'), 'slide-image': () => ops.addSlide('image'), 'slide-stat': () => ops.addSlide('stat'),
  'slide-duplicate': ops.duplicateSlide, 'slide-delete': ops.deleteSlide,
  preview, present: () => window.open(`/decks/${app.deck}/deck.html?notes#${app.index + 1}`, `deck-${app.deck}`),
  export: exportDeck,
  'claude-stop': stopClaude,
};
export function run(cmd) {
  if (app.busy && cmd !== 'claude-stop' && cmd !== 'present' && cmd !== 'preview') return toast('Claude is editing; wait or press Stop.');
  closeMenus();
  if (cmd !== 'undo' && cmd !== 'redo') stopTextEdit();
  commands[cmd] && commands[cmd]();
}

function wire() {
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-cmd]');
    if (c) { e.preventDefault(); run(c.dataset.cmd); return; }
    const m = e.target.closest('[data-menu]');
    if (m) { const menu = $('#menu-' + m.dataset.menu); const was = menu.classList.contains('open'); closeMenus(); menu.classList.toggle('open', !was); return; }
    if (!e.target.closest('.menu')) closeMenus();
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', e => { if (!e.target.closest('input, textarea, [contenteditable="true"]')) onPaste(e); });
  $('#file-input').onchange = async e => { for (const f of e.target.files) await insertFile(f); e.target.value = ''; };
  $('#deck-title').onchange = e => {
    const t = e.target.value.replace(/[<&]/g, '').trim() || app.deck;
    app.history.push({ html: app.html, js: app.js, label: 'Title' });
    app.html = app.html.replace(/<title>[^<]*<\/title>/i, `<title>${t}</title>`);
    document.title = `${t} · Deckelsmouk`;
    save();
  };
  addEventListener('resize', () => { fitThumbs(); draw(); });
  app.on('change', () => syncThumbs());
}

/* ── Keyboard ── */

function onKey(e) {
  if (!$('#preview').hidden) { if (e.key === 'Escape') closePreview(); return; }
  if (app.editing) { textKey(e); return; }
  const t = e.target;
  if (t.closest && t.closest('input, textarea, select, [contenteditable="true"]') && t.ownerDocument === document) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusPrompt(); }
    return;
  }
  const mod = e.metaKey || e.ctrlKey, k = e.key, K = k.toLowerCase();
  if (app.busy && !(mod && K === 'k')) return;
  const inThumbs = t.ownerDocument === app.tdoc;
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  if (mod) {
    if (K === 'z') { handled(); return e.shiftKey ? redo() : undo(); }
    if (K === 'y') { handled(); return redo(); }
    if (K === 'k') { handled(); return focusPrompt(); }
    if (K === 's') { handled(); return toast('Everything is saved automatically.', 1800); }
    if (K === 'd') { handled(); return inThumbs ? ops.duplicateSlide() : ops.duplicate(); }
    if (K === 'a') { handled(); return ops.selectAll(); }
    if (K === 'c') { if (ops.copy()) handled(); return; }
    if (K === 'x') { if (ops.copy(true)) handled(); return; }
    if (K === 'v') { // the paste event normally handles this; fall back to the editor's own clipboard if it never comes
      app._pasted = false;
      setTimeout(() => { if (!app._pasted && app.clipboard) ops.paste(); }, 120);
      return;
    }
    if (K === 'enter') { handled(); return run('preview'); }
    return;
  }
  if (k === 'Escape') { closeMenus(); if (app.selection.length) setSelection([]); return; }
  if (k === 'Delete' || k === 'Backspace') { handled(); return inThumbs || !app.selection.length ? (inThumbs && ops.deleteSlide()) : ops.deleteSelection(); }
  if (k === 'PageDown' || (inThumbs && k === 'ArrowDown') || (!app.selection.length && k === 'ArrowDown')) { handled(); return showSlide(app.index + 1); }
  if (k === 'PageUp' || (inThumbs && k === 'ArrowUp') || (!app.selection.length && k === 'ArrowUp')) { handled(); return showSlide(app.index - 1); }
  if (k.startsWith('Arrow') && app.selection.length) {
    handled();
    const d = e.shiftKey ? 10 : 1;
    return ops.nudge(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0);
  }
  if (k === 'Enter' && app.selection.length === 1 && app.selection[0].textContent.trim()) { handled(); return startTextEdit(app.selection[0], null, null, true); }
  if (k === 't' || k === 'T') { handled(); return run('insert-text'); }
}

/* ── Preview, export ── */

function preview() {
  const p = $('#preview'), f = $('#preview-frame');
  p.hidden = false;
  f.onload = () => {
    f.contentWindow.focus();
    f.contentDocument.addEventListener('keydown', e => { if (e.key === 'Escape') closePreview(); });
  };
  f.src = `/decks/${app.deck}/deck.html?v=${Date.now()}#${app.index + 1}.0`;
  p.onclick = e => { if (e.target === p) closePreview(); };
}
function closePreview() { $('#preview').hidden = true; $('#preview-frame').src = 'about:blank'; app.frame.focus(); }

async function exportDeck() {
  toast('Building…', 0);
  try {
    const r = await api.post(`/api/build?deck=${app.deck}`);
    toast(`Built <b>dist/${app.deck}.html</b> (${r.kb} KB, everything inlined) · <a href="${r.path}" target="_blank">Open</a> · <a href="${r.path}" download="${app.deck}.html">Download</a>`, 9000);
  } catch (e) { toast('Build failed: ' + e.message); }
}

/* ── Live reload: edits from Claude Code in a terminal, VS Code or git show up at once ── */

function liveReload() {
  const es = new EventSource('/api/events');
  let t;
  es.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type !== 'change' || app.busy) return;
    if (m.deck !== app.deck && !String(m.file).startsWith('runtime/')) return;
    clearTimeout(t);
    t = setTimeout(async () => {
      if (String(m.file).startsWith('runtime/')) { await loadFrames(); showSlide(app.index); return; }
      const d = await api.get(`/api/deck?deck=${app.deck}`);
      if (d.html === app.html && d.js === app.js) return;
      stopTextEdit();
      await replaceDeck({ html: d.html, js: d.js }, { record: true, write: false, label: 'Outside edit' });
      $('#deck-title').value = titleOf(app.html);
      toast('Reloaded changes from disk.', 1800);
    }, 150);
  };
}

/* ── Start ── */

if (params.get('deck')) open(params.get('deck')).catch(e => { toast(e.message, 0); console.error(e); });
else picker();
