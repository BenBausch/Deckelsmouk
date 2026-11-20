// Boot, start page (decks, templates, import), toolbar, keyboard shortcuts, slide list, live reload, preview and export.
import { app, $, $$, api, toast, dialog, loadFrames, showSlide, slides, currentSlide, undo, redo, replaceDeck, fitThumbs, setSelection, save, flush, syncThumbs, deckQuery } from './app.js';
import { initCanvas, attachCanvas, insertFile, startTextEdit, stopTextEdit, textKey, onPaste, draw, closeMenus } from './canvas.js';
import * as ops from './ops.js';
import { initInspector } from './inspector.js';
import { initClaude, focusPrompt, ask, note, suggest, stop as stopClaude } from './claude.js';
import { audiencePicker, audienceDialog, lengthPicker } from './audience.js';
import { openHistory, saveVersion } from './history.js';
import { openFonts } from './fonts.js';
import { readAudience, writeAudience, audienceLabel, audienceByKey, DEFAULT_AUDIENCE, readDuration, writeDuration, DEFAULT_LENGTH, slideCount } from './audiences.js';

const params = new URLSearchParams(location.search);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { // sessionStorage, which may be blocked
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* blocked */ } },
  take(k) { const v = this.get(k); try { sessionStorage.removeItem(k); } catch { /* blocked */ } return v; },
};
// The audience picked last, offered again for the next deck (a convenience: may be unavailable).
const lastAudience = {
  get() { try { const v = JSON.parse(localStorage.getItem('deck-audience')); return v && audienceByKey(v.key) ? v : { key: DEFAULT_AUDIENCE, text: '' }; } catch { return { key: DEFAULT_AUDIENCE, text: '' }; } },
  set(v) { try { localStorage.setItem('deck-audience', JSON.stringify(v)); } catch { /* blocked */ } },
};
const lastLength = {
  get() { try { return +localStorage.getItem('deck-length') || DEFAULT_LENGTH; } catch { return DEFAULT_LENGTH; } },
  set(v) { try { localStorage.setItem('deck-length', String(v)); } catch { /* blocked */ } },
};

/* ── Start page: new deck, templates, decks ── */

// A live, scaled preview of a deck's or template's first slide.
function thumb(src) {
  const box = document.createElement('div');
  box.className = 'thumb';
  box.innerHTML = `<iframe loading="lazy" tabindex="-1" src="${src}"></iframe>`;
  const fr = box.firstChild;
  new ResizeObserver(() => { fr.style.transform = `scale(${box.clientWidth / 1920})`; }).observe(box);
  return box;
}

async function picker() {
  $('#picker').hidden = false;
  const form = $('#new-deck');
  // 1. Talk length, 2. audience, 3. template, 4. draft material.
  const length = lengthPicker($('#length-picker'), lastLength.get(), v => { lastLength.set(v); updateCreate(); });
  const audience = audiencePicker($('#audience-picker'), lastAudience.get(), v => { lastAudience.set(v); updateCreate(); });
  // The ⋯ menus close on a click elsewhere, Escape, scrolling or resizing.
  document.addEventListener('click', e => { if (!e.target.closest('#card-menu, .more')) closeCardMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCardMenu(); });
  $('#picker').addEventListener('scroll', closeCardMenu);
  addEventListener('resize', closeCardMenu);

  // Draft material: pasted text plus attached files (documents go to the deck's source/, pictures to assets/).
  const attached = [];
  const isPicture = f => /^image\//.test(f.type) || /\.(png|jpe?g|gif|svg|webp)$/i.test(f.name);
  const attach = files => {
    for (const f of files) {
      if (/\.(docx?|pptx?|potx|key|odp|odt|pages)$/i.test(f.name)) { toast(`Claude can't read ${esc(f.name)} directly: save it as PDF and attach that.`, 6000); continue; }
      if (!isPicture(f) && !/\.(pdf|txt|md|markdown|tex|csv|json|html?)$/i.test(f.name)) { toast(`${esc(f.name)}: attach PDFs, text, Markdown or pictures.`, 5000); continue; }
      if (!attached.some(a => a.name === f.name && a.size === f.size)) attached.push(f);
    }
    renderAttached();
  };
  const renderAttached = () => {
    $('.draft-list').innerHTML = attached.map((f, i) => `<li><span class="kind">${isPicture(f) ? 'Picture' : 'Material'}</span><span class="name">${esc(f.name)}</span><span class="size">${f.size > 1e6 ? (f.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1e3)) + ' KB'}</span><button type="button" data-unattach="${i}" title="Remove">✕</button></li>`).join('');
    updateCreate();
  };
  $('.draft-list').onclick = e => { const b = e.target.closest('[data-unattach]'); if (b) { attached.splice(+b.dataset.unattach, 1); renderAttached(); } };
  $('#draft [data-attach]').onclick = () => $('#draft input[type=file]').click();
  $('#draft input[type=file]').onchange = e => { attach([...e.target.files]); e.target.value = ''; };
  form.elements.notes.oninput = () => updateCreate();
  const drafting = () => !!(form.elements.notes.value.trim() || attached.length);
  function updateCreate() {
    const on = drafting();
    $('#create-btn').textContent = on ? 'Create and draft with Claude' : 'Create deck';
    $('#create-hint').textContent = on ? `Claude writes about ${slideCount(length.value(), audience.peek())} slides from your material; you watch it happen in the editor.` : '';
  }
  updateCreate();

  form.onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(form);
    const aud = audience.value(); // null: the custom description is still empty (the picker says so)
    if (!aud) return toast('Describe the audience, or pick one of the others.');
    const btn = $('#create-btn');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const r = await api.post('/api/new', { name: f.get('name'), title: f.get('title'), template: f.get('template'), audience: aud, minutes: length.value(), notes: f.get('notes') });
      const q = `deck=${encodeURIComponent(r.name)}`, images = [];
      for (const file of attached) {
        const up = await fetch(`/api/upload?${q}&name=${encodeURIComponent(file.name)}${isPicture(file) ? '' : '&to=source'}`, { method: 'POST', headers: { 'X-Deck': '1' }, body: file });
        if (!up.ok) throw new Error(`Could not upload ${file.name}`);
        if (isPicture(file)) images.push((await up.json()).path);
      }
      if (drafting()) {
        const d = await api.post(`/api/deck/draft?${q}`, { images });
        store.set(`deck-ask:${r.name}`, d.prompt);
        store.set(`deck-ask-shown:${r.name}`, d.shown);
      }
      location.href = `/?${q}`;
    } catch (err) { btn.disabled = false; updateCreate(); toast(esc(err.message), 6000); }
  };

  // Files dropped on the Draft box are material; anywhere else they make a template (import).
  $('#import-input').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importTemplate(f); };
  let depth = 0;
  const hint = $('#drop-hint'), box = $('#draft');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  const inDraft = e => !!(e.target.closest && e.target.closest('#draft'));
  addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; hint.hidden = inDraft(e); } });
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; hint.hidden = true; box.classList.remove('drag'); } });
  addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hint.hidden = inDraft(e);
    box.classList.toggle('drag', inDraft(e));
  });
  addEventListener('drop', e => {
    e.preventDefault(); depth = 0; hint.hidden = true; box.classList.remove('drag');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (inDraft(e)) attach(files); else importTemplate(files[0]);
  });
  // The lists come last: the form already works while they load.
  await renderTemplates();
  await renderDecks();
}

/* ── Templates on the start page: click to use one for the next deck; ⋯ to edit, duplicate or delete ── */

let chosen = null; // the template the next deck uses; '' = the built-in blank deck

function choose(name, title) {
  chosen = name;
  store.set('deck-template', name);
  $('#new-deck').elements.template.value = name;
  $$('.template-card[data-name]').forEach(c => c.classList.toggle('on', c.dataset.name === name));
  $('#template-chosen').textContent = title;
}

async function renderTemplates() {
  const templates = await api.get('/api/templates');
  // A server started before an update answers in the old format (names only) and lacks newer routes.
  if (templates.some(t => typeof t === 'string')) {
    toast('The dev server is older than the editor. Restart it (Ctrl+C, then <b>npm run dev</b>) to use templates and import.', 0);
    templates.forEach((t, i) => { if (typeof t === 'string') templates[i] = { name: t, title: t, layouts: 0, description: '' }; });
  }
  const names = templates.map(t => t.name);
  // Keep the choice while it exists; otherwise the default template, or blank when there is none.
  const saved = chosen ?? store.get('deck-template');
  chosen = saved === '' || names.includes(saved) ? saved : names.includes('default') ? 'default' : '';

  const tlist = $('#template-list');
  tlist.replaceChildren();
  // Blank: the built-in plain deck, always available (and the only choice when there are no templates).
  const blank = document.createElement('div');
  blank.className = 'template-card blank-card';
  blank.dataset.name = '';
  blank.title = 'Start the new deck blank';
  blank.innerHTML = `<div class="thumb"><span>Aa</span></div><div class="meta"><b>Blank</b><span>A plain, light deck with simple layouts</span></div>`;
  blank.onclick = () => choose('', 'a blank deck');
  tlist.append(blank);

  templates.forEach(t => {
    const card = document.createElement('div');
    card.className = 'template-card';
    card.dataset.name = t.name;
    card.title = 'Use this template for the new deck';
    card.append(thumb(`/templates/${encodeURIComponent(t.name)}/deck.html?edit`));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b></b><span>${t.layouts} layout${t.layouts === 1 ? '' : 's'}${t.description ? ' · ' + esc(t.description) : ''}</span>`;
    meta.querySelector('b').textContent = t.title;
    card.append(meta);
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'more'; more.textContent = '⋯'; more.title = 'Edit, duplicate or delete';
    more.onclick = e => {
      e.stopPropagation();
      cardMenu(more, `templates/${t.name}`, [['edit', 'Edit'], ['duplicate', 'Duplicate'], ['delete', 'Delete…', 'danger']], act => templateAction(act, t));
    };
    card.append(more);
    card.onclick = e => { if (!e.target.closest('.more')) choose(t.name, t.title); };
    tlist.append(card);
  });

  const action = (cls, icon, label, sub, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `template-card action ${cls}`;
    b.innerHTML = `<div class="thumb"><span>${icon}</span></div><div class="meta"><b>${label}</b><span>${sub}</span></div>`;
    b.onclick = fn;
    tlist.append(b);
  };
  action('import', '⇪', 'Import a template', 'PowerPoint (.pptx, .potx), HTML or PDF. Or drop the file on this page.', () => $('#import-input').click());
  const startsFrom = names.includes('default') ? 'the default design' : 'the blank design';
  action('new', '＋', 'New template', `Start from ${startsFrom}`, async () => {
    const name = await dialog({ title: 'New template', text: `It starts as a copy of ${startsFrom}. Name it after your university, company or style.`, input: '', placeholder: 'Template name', ok: 'Create' });
    if (!name) return;
    try { const r = await api.post('/api/template', { name }); location.href = `/?template=${encodeURIComponent(r.name)}`; }
    catch (err) { toast(esc(err.message)); }
  });
  choose(chosen, chosen ? templates.find(t => t.name === chosen).title : 'a blank deck');
}

async function templateAction(act, t) {
  try {
    if (act === 'edit') { location.href = `/?template=${encodeURIComponent(t.name)}`; return; }
    if (act === 'duplicate') {
      const r = await api.post('/api/template', { name: `${t.title} copy`, from: `templates/${t.name}` });
      toast(`Duplicated as <b>${esc(r.name)}</b>.`);
    } else if (act === 'delete') {
      const sure = await dialog({
        title: `Delete the template “${t.title}”?`,
        text: `This removes templates/${t.name}/ for good${t.description.startsWith('Imported') ? ', with the original it was imported from' : ''}. Decks made from it keep their design.`,
        ok: 'Delete', danger: true,
      });
      if (!sure) return;
      await api.del(`/api/template?name=${encodeURIComponent(t.name)}`);
      toast(`Template <b>${esc(t.title)}</b> deleted.`);
    }
    await renderTemplates();
  } catch (e) { toast(esc(e.message), 6000); }
}

/* ── Decks on the start page: open, or ⋯ to duplicate, archive (archive/), restore or delete ── */

async function renderDecks() {
  const [decks, archived] = await Promise.all([api.get('/api/decks'), api.get('/api/decks?archived=1')]);
  const list = $('#deck-list');
  list.replaceChildren(...decks.map(d => deckCard(d, false)));
  if (!decks.length) list.innerHTML = '<p class="sub">No decks yet. Create one above.</p>';
  $('#archive-section').hidden = !archived.length;
  $('#archive-count').textContent = `${archived.length} deck${archived.length === 1 ? '' : 's'}`;
  $('#archive-list').replaceChildren(...archived.map(d => deckCard(d, true)));
}

function deckCard(d, archived) {
  const card = document.createElement('div');
  card.className = 'deck-card';
  const open = document.createElement(archived ? 'div' : 'a');
  open.className = 'open';
  if (!archived) open.href = `/?deck=${encodeURIComponent(d.name)}`;
  open.append(thumb(`/${archived ? 'archive' : 'decks'}/${encodeURIComponent(d.name)}/deck.html?edit`));
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<b></b><span>${esc(d.name)} · ${d.slides} slide${d.slides === 1 ? '' : 's'}${d.audience ? ` · for ${esc(audienceLabel(d.audience))}` : ''}${d.minutes ? ` · ${d.minutes} min` : ''} · ${new Date(d.modified).toLocaleDateString()}</span>`;
  meta.querySelector('b').textContent = d.title;
  open.append(meta);
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'more'; more.textContent = '⋯';
  more.title = archived ? 'Restore or delete' : 'Duplicate, archive or delete';
  const items = archived
    ? [['restore', 'Restore'], ['delete', 'Delete…', 'danger']]
    : [['duplicate', 'Duplicate'], ['archive', 'Archive'], ['delete', 'Delete…', 'danger']];
  const menu = () => cardMenu(more, `${archived ? 'archive' : 'decks'}/${d.name}`, items, act => deckAction(act, d, archived));
  more.onclick = e => { e.preventDefault(); e.stopPropagation(); menu(); };
  if (archived) open.onclick = e => { e.stopPropagation(); menu(); };
  card.append(open, more);
  return card;
}

// The ⋯ menu of a deck or template card: items are [action, label, class?]; pick(action) runs the chosen one.
function cardMenu(btn, key, items, pick) {
  const menu = $('#card-menu');
  if (menu.classList.contains('open') && menu.dataset.for === key) return closeCardMenu();
  closeCardMenu();
  menu.innerHTML = items.map(([act, label, cls]) => `<button type="button" role="menuitem" data-act="${act}" class="${cls || ''}">${label}</button>`).join('');
  menu.dataset.for = key;
  menu.onclick = e => { const b = e.target.closest('[data-act]'); if (b) { closeCardMenu(); pick(b.dataset.act); } };
  menu.classList.add('open');
  btn.classList.add('on');
  // Under the button, right-aligned; above it when there's no room below.
  const r = btn.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  menu.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
}
function closeCardMenu() {
  $('#card-menu').classList.remove('open');
  $$('.more.on').forEach(b => b.classList.remove('on'));
}

async function deckAction(act, d, archived) {
  const q = `deck=${encodeURIComponent(d.name)}`;
  try {
    if (act === 'duplicate') {
      const r = await api.post(`/api/deck/duplicate?${q}`);
      toast(`Duplicated as <b>${esc(r.title)}</b>.`);
    } else if (act === 'archive') {
      await api.post(`/api/deck/archive?${q}`);
      toast(`<b>${esc(d.title)}</b> archived. Find it under Archived at the bottom to restore it.`, 5000);
    } else if (act === 'restore') {
      await api.post(`/api/deck/restore?${q}`);
      toast(`<b>${esc(d.title)}</b> is back with your decks.`);
    } else if (act === 'delete') {
      const where = `${archived ? 'archive' : 'decks'}/${d.name}/`;
      const sure = await dialog({
        title: `Delete “${d.title}”?`,
        text: `This removes ${where} with its pictures and cannot be undone.${archived ? '' : '\nArchive hides a deck without deleting it.'}`,
        ok: 'Delete', danger: true,
      });
      if (!sure) return;
      await api.del(`/api/deck?${q}${archived ? '&archived=1' : ''}`);
      toast(`<b>${esc(d.title)}</b> deleted.`);
    }
    await renderDecks();
  } catch (e) { toast(esc(e.message), 6000); }
}

async function importTemplate(file) {
  toast(`Importing <b>${esc(file.name)}</b>…`, 0);
  try {
    const r = await api.post(`/api/import?name=${encodeURIComponent(file.name)}`, file, true);
    const ref = `templates/${r.name}`;
    if (r.prompt) store.set(`deck-ask:${ref}`, r.prompt);
    store.set(`deck-imported:${ref}`, JSON.stringify({ file: file.name, report: r.report || null, claude: !!r.prompt }));
    location.href = `/?template=${encodeURIComponent(r.name)}`;
  } catch (err) { toast(esc(err.message), 10000); }
}

/* ── Editor ── */

async function open(ref) {
  app.deck = ref;
  app.kind = ref.startsWith('templates/') ? 'template' : 'deck';
  app.base = '/' + (app.kind === 'template' ? ref : `decks/${ref}`).split('/').map(encodeURIComponent).join('/');
  document.body.classList.toggle('mode-template', app.kind === 'template');
  $('#editor').hidden = false;
  app.frame = $('#frame');
  app.thumbs = $('#thumbs');
  const d = await api.get(`/api/deck?${deckQuery()}`);
  app.html = d.html; app.js = d.js; app.source = d.source || [];
  document.title = `${titleOf(app.html)} · Deckelsmouk`;
  $('#deck-title').value = titleOf(app.html);
  showAudience();
  app.on('change', showAudience); // undo, redo and outside edits can change it too
  app.index = Math.max(0, (+params.get('slide') || 1) - 1);
  initCanvas(); initInspector(); initClaude();
  app.on('frame', onFrame);
  app.on('font-files', files => { if (!app.busy) openFonts(files); }); // font files dropped on a slide
  const urlKey = app.kind === 'template' ? `template=${encodeURIComponent(ref.slice(10))}` : `deck=${encodeURIComponent(ref)}`;
  app.on('slide', () => history.replaceState(null, '', `/?${urlKey}&slide=${app.index + 1}`));
  await loadFrames();
  showSlide(Math.min(app.index, slides().length - 1));
  wire();
  liveReload();
  // Versions for the History panel: now, and every 10 minutes while the deck is being edited.
  saveVersion('Opened in the editor');
  let edited = false;
  app.on('change', () => { edited = true; });
  setInterval(() => { if (edited) { edited = false; saveVersion('While editing'); } }, 10 * 60 * 1000);
  afterImport();
}

// Right after an import: say what came in, and let Claude finish what the converter can't do.
function afterImport() {
  const info = store.take(`deck-imported:${app.deck}`);
  const prompt = store.take(`deck-ask:${app.deck}`);
  if (info) {
    const { file, report, claude } = JSON.parse(info);
    if (report) {
      note(`Imported ${file}: ${report.layouts.length} layouts, the theme colours${report.fonts.length ? ` and fonts (${report.fonts.join(', ')})` : ''}${report.images ? `, ${report.images} image${report.images === 1 ? '' : 's'}` : ''}. Each slide of a template is a layout: edit them like slides.`);
      report.warnings.forEach(w => note(w));
      note('Not quite like the original? The “Polish import” suggestion asks Claude to compare it with the PowerPoint file.');
    } else if (claude) note(`Imported ${file}. Claude now gives this template the original's look.`);
  }
  const shown = store.take(`deck-ask-shown:${app.deck}`); // a deck drafted from the start page says what it does
  if (prompt) ask(prompt, shown || `Give this template the look of ${info ? JSON.parse(info).file : 'the original'}: theme, master decorations and layouts.`);
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
  'slide-new': d => ops.addSlide(d.layout, d.label),
  'slide-layout': d => ops.addSlideFromLayout(+d.index),
  'slide-duplicate': ops.duplicateSlide, 'slide-delete': ops.deleteSlide,
  preview, present: () => window.open(`${app.base}/deck.html#${app.index + 1}`, `deck-${app.deck}`),
  export: exportDeck,
  'save-template': saveAsTemplate, 'use-template': deckFromTemplate, 'duplicate-template': duplicateTemplate, 'delete-template': deleteThisTemplate,
  audience: changeAudience,
  history: openHistory,
  fonts: () => openFonts(),
  'change-template': changeTemplateDialog,
  'claude-stop': stopClaude,
};
export function run(cmd, data = {}) {
  if (app.busy && cmd !== 'claude-stop' && cmd !== 'present' && cmd !== 'preview') return toast('Claude is editing; wait or press Stop.');
  closeMenus();
  if (cmd !== 'undo' && cmd !== 'redo') stopTextEdit();
  commands[cmd] && commands[cmd](data);
}

/* ── + Slide: the deck's layouts (from its template), or simple built-in ones ── */

const BUILT_IN = [['blank', 'Blank'], ['title', 'Title'], ['text', 'Title and text'], ['bullets', 'Title and bullets'], ['image', 'Title and image'], ['stat', 'Big number']];

function slideMenu() {
  const menu = $('#menu-newslide');
  const layouts = app.kind === 'deck' ? ops.deckLayouts() : [];
  const item = (attrs, label) => `<button ${attrs}>${esc(label)}</button>`;
  const hasBlank = layouts.some(l => /^blank$/i.test(l.title));
  menu.innerHTML = layouts.length
    ? `<div class="menu-head">Layouts</div>${layouts.map((l, i) => item(`data-cmd="slide-layout" data-index="${i}"`, l.title)).join('')}${hasBlank ? '' : `<hr>${item('data-cmd="slide-new" data-layout="blank" data-label="Blank"', 'Blank')}`}`
    : `${app.kind === 'template' ? '<div class="menu-head">New layout</div>' : ''}${BUILT_IN.map(([k, l]) => item(`data-cmd="slide-new" data-layout="${k}" data-label="${l}"`, l)).join('')}`;
}

/* ── Templates ── */

async function saveAsTemplate() {
  const name = await dialog({ title: 'Save design as template', text: 'The theme, decorations and assets become a template, and each slide of this deck becomes one of its layouts.', input: titleOf(app.html), placeholder: 'Template name', ok: 'Save template' });
  if (!name) return;
  try {
    const r = await api.post('/api/template', { name, from: app.deck });
    toast(`Template <b>${esc(name)}</b> saved. <a href="/?template=${encodeURIComponent(r.name)}">Open it</a> to tidy its layouts.`, 9000);
  } catch (e) { toast(esc(e.message)); }
}

/* ── Audience: who the deck is for (stored in deck.html, given to Claude with every request) ── */

function showAudience() {
  const aud = readAudience(app.html), min = readDuration(app.html);
  $('#audience-name').textContent = [aud ? audienceLabel(aud) : 'Audience', min && `${min} min`].filter(Boolean).join(' · ');
  $('#audience-btn').classList.toggle('unset', !aud);
}

async function changeAudience() {
  const next = await audienceDialog({ audience: readAudience(app.html), minutes: readDuration(app.html) || lastLength.get() });
  if (!next) return;
  const html = writeDuration(writeAudience(app.html, next.audience), next.minutes);
  if (html === app.html) return;
  app.history.push({ html: app.html, js: app.js, label: 'Audience' });
  app.future = [];
  app.html = html;
  lastAudience.set(next.audience);
  lastLength.set(next.minutes);
  save();
  showAudience();
  app.emit('select'); // the Claude suggestions depend on it
  toast(`Audience: <b>${esc(audienceLabel(next.audience))}</b>, ${next.minutes} minutes. Claude writes for them from now on; “Fit to audience” reworks a slide.`, 5000);
}

async function deckFromTemplate() {
  const name = await dialog({ title: 'New deck from this template', text: 'The deck starts with the first layout; + Slide offers the others.', input: '', placeholder: 'Deck name', ok: 'Create deck' });
  if (!name) return;
  try {
    const r = await api.post('/api/new', { name, template: app.deck.slice('templates/'.length), audience: lastAudience.get() });
    location.href = `/?deck=${encodeURIComponent(r.name)}`;
  } catch (e) { toast(esc(e.message)); }
}

async function duplicateTemplate() {
  const name = await dialog({ title: 'Duplicate template', input: `${titleOf(app.html)} copy`, placeholder: 'Name of the copy', ok: 'Duplicate' });
  if (!name) return;
  try {
    const r = await api.post('/api/template', { name, from: app.deck });
    location.href = `/?template=${encodeURIComponent(r.name)}`;
  } catch (e) { toast(esc(e.message)); }
}

// Gives this deck another template's design (never automatic: only when asked, here).
async function changeTemplateDialog() {
  let templates;
  try { templates = await api.get('/api/templates'); } catch (e) { return toast(esc(e.message)); }
  const current = (/<meta name="deck-template" content="([^"]*)"/.exec(app.html) || [])[1] || '';
  const d = document.createElement('dialog');
  d.className = 'dialog wide change-template';
  d.innerHTML = `<form><h3>Change template</h3>
    <p>The deck gets the new template’s theme, fonts, decorations and layouts. Its slides, their content and animations stay. A version is saved first, and ⌘Z undoes the change.</p>
    <div class="template-list"></div>
    <div class="dialog-btns"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary" disabled>Apply template</button></div></form>`;
  const list = d.querySelector('.template-list'), apply = d.querySelector('[type=submit]');
  let picked = null;
  const card = (name, title, sub, preview) => {
    const c = document.createElement('div');
    c.className = 'template-card' + (name === '' ? ' blank-card' : '');
    c.dataset.name = name;
    c.append(preview);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b></b><span>${esc(sub)}${name === current ? ' · <em>current</em>' : ''}</span>`;
    meta.querySelector('b').textContent = title;
    c.append(meta);
    c.onclick = () => {
      picked = name;
      list.querySelectorAll('.template-card').forEach(x => x.classList.toggle('on', x === c));
      apply.disabled = name === current;
      apply.textContent = name === current ? 'This is the current template' : `Apply “${title}”`;
    };
    list.append(c);
  };
  const blankThumb = document.createElement('div');
  blankThumb.className = 'thumb'; blankThumb.innerHTML = '<span>Aa</span>';
  card('', 'Blank', 'A plain, light design', blankThumb);
  templates.forEach(t => card(t.name, t.title, `${t.layouts} layout${t.layouts === 1 ? '' : 's'}`, thumb(`/templates/${encodeURIComponent(t.name)}/deck.html?edit`)));
  const done = () => { d.close(); d.remove(); };
  d.querySelector('[data-cancel]').onclick = done;
  d.addEventListener('cancel', e => { e.preventDefault(); done(); });
  d.addEventListener('mousedown', e => { if (e.target === d) done(); });
  d.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    if (picked === null || picked === current) return;
    apply.disabled = true; apply.textContent = 'Applying…';
    try {
      await flush();
      const r = await api.post(`/api/deck/template?${deckQuery()}`, { template: picked });
      done();
      await replaceDeck({ html: r.html, js: app.js }, { record: true, label: 'Change template' });
      const { kept, matched, plain, size } = r.report, n = (k, w) => `${k} slide${k === 1 ? '' : 's'} ${w}`;
      const parts = [kept && n(kept, 'kept their layout'), matched && n(matched, 'got the closest layout'), plain && n(plain, 'use the plain master look')].filter(Boolean);
      toast(`Template changed to <b>${esc(r.name)}</b>.${parts.length ? ' ' + esc(parts.join(', ')) + '.' : ''} ⌘Z undoes it.`, 7000);
      if (size) note(size);
      note(`Template changed to ${r.name}. Claude can fit the slides to it: the request is ready in the prompt bar.`);
      suggest(`The deck now uses the template “${r.name}”. Go through the slides and fit them to it: keep content clear of its decorations (logo, bars, pictures), use its layouts’ positions for titles and text where that fits, and keep margins consistent. Keep the content.`);
    } catch (err) { apply.disabled = false; apply.textContent = 'Apply template'; toast(esc(err.message)); }
  };
  document.body.append(d);
  d.showModal();
  list.querySelector(`.template-card[data-name="${CSS.escape(current)}"]`)?.click();
}

async function deleteThisTemplate() {
  const name = app.deck.slice('templates/'.length), title = titleOf(app.html);
  const sure = await dialog({ title: `Delete the template “${title}”?`, text: `This removes templates/${name}/ for good. Decks made from it keep their design.`, ok: 'Delete', danger: true });
  if (!sure) return;
  try { await api.del(`/api/template?name=${encodeURIComponent(name)}`); location.href = '/'; }
  catch (e) { toast(esc(e.message)); }
}

function wire() {
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-cmd]');
    if (c) { e.preventDefault(); run(c.dataset.cmd, c.dataset); return; }
    const m = e.target.closest('[data-menu]');
    if (m) {
      if (m.dataset.menu === 'newslide') slideMenu();
      const menu = $('#menu-' + m.dataset.menu); const was = menu.classList.contains('open'); closeMenus(); menu.classList.toggle('open', !was);
      return;
    }
    if (!e.target.closest('.menu')) closeMenus();
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', e => { if (!e.target.closest('input, textarea')) onPaste(e); });
  $('#file-input').onchange = async e => {
    // With an image placeholder selected, the first picture fills it.
    let ph = app.selection.length === 1 && app.selection[0].matches('.ph-image') ? app.selection[0] : null;
    for (const f of e.target.files) { await insertFile(f, null, ph); ph = null; }
    e.target.value = '';
  };
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
  f.src = `${app.base}/deck.html?v=${Date.now()}#${app.index + 1}.0`;
  p.onclick = e => { if (e.target === p) closePreview(); };
}
function closePreview() { $('#preview').hidden = true; $('#preview-frame').src = 'about:blank'; app.frame.focus(); }

async function exportDeck() {
  toast('Building…', 0);
  try {
    const r = await api.post(`/api/build?${deckQuery()}`);
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
      const d = await api.get(`/api/deck?${deckQuery()}`);
      if (d.html === app.html && d.js === app.js) return;
      stopTextEdit();
      await replaceDeck({ html: d.html, js: d.js }, { record: true, write: false, label: 'Outside edit' });
      $('#deck-title').value = titleOf(app.html);
      toast('Reloaded changes from disk.', 1800);
    }, 150);
  };
}

/* ── Start ── */

const opening = params.get('template') ? `templates/${params.get('template')}` : params.get('deck');
if (opening) open(opening).catch(e => { toast(esc(e.message), 0); console.error(e); });
else picker();
