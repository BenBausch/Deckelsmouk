// The prompt bar: sends the request plus what is selected (slide, objects, their HTML and boxes) to Claude Code,
// streams what it does, then loads its changes into the editor as one undoable step.
import { app, $, api, flush, currentSlide, slides, selectorFor, replaceDeck, toast } from './app.js';
import { boxOf, stopTextEdit } from './canvas.js';

const CHIPS_SEL = [
  ['Animate in sequence', 'Animate the selected objects so they appear one after another on clicks, with fitting effects.'],
  ['Align neatly', 'Align and distribute the selected objects on a clean grid with consistent spacing.'],
  ['Make it stand out', 'Make the selected object stand out more: stronger typography, colour or a subtle highlight, in the deck\'s style.'],
  ['Custom effect', 'Write a new named effect in animations.js that suits the selected object and use it on it.'],
];
const CHIPS_SLIDE = [
  ['Tidy this slide', 'Tidy the layout of this slide: clear hierarchy, aligned edges, balanced whitespace. Keep the content.'],
  ['Animate this slide', 'Add tasteful entrance animations to this slide, with click steps where it helps the story.'],
  ['Write notes', 'Write concise speaker notes for this slide.'],
  ['Next slide from this', 'Add a new slide after this one that continues the story, in the same style.'],
];

let running = null;

export function initClaude() {
  const input = $('#claude-input'), form = $('#claude-form');
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape') input.blur();
  });
  form.addEventListener('submit', e => { e.preventDefault(); send(); });
  $('#claude-new').onclick = async () => {
    await api.post(`/api/claude/reset?deck=${app.deck}`);
    $('#claude-log').replaceChildren(); $('#claude-log').hidden = true;
    toast('New conversation: Claude starts without the earlier requests.');
  };
  try { $('#claude-model').value = localStorage.getItem('deck-model') || ''; } catch { /* storage blocked */ }
  $('#claude-model').onchange = e => { try { localStorage.setItem('deck-model', e.target.value); } catch { /* ignore */ } };
  app.on('select', context);
  app.on('slide', context);
  app.on('frame', context);
}

function grow() { const t = $('#claude-input'); t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px'; }

function context() {
  const s = currentSlide();
  if (!s) return;
  const n = app.selection.length;
  $('#claude-ctx').textContent = `Slide ${app.index + 1}${n ? ` · ${n === 1 ? (app.selection[0].dataset.el || app.selection[0].tagName.toLowerCase()) : n + ' objects'}` : ''}`;
  const chips = n ? CHIPS_SEL : CHIPS_SLIDE;
  const box = $('#claude-chips');
  box.replaceChildren(...chips.map(([label, text]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = text;
    b.onclick = () => { const i = $('#claude-input'); i.value = text; grow(); i.focus(); };
    return b;
  }));
}

export function focusPrompt() { const i = $('#claude-input'); i.focus(); i.select(); }

function log(kind, text) {
  const l = $('#claude-log');
  l.hidden = false;
  const d = document.createElement('div');
  d.className = 'msg ' + kind;
  d.textContent = text;
  l.append(d);
  l.scrollTop = l.scrollHeight;
  return d;
}

function selectionPayload() {
  const s = currentSlide();
  const steps = app.win.Deck.steps ? app.win.Deck.steps(s) : 0;
  return {
    slide: { index: app.index, count: slides().length, id: s.id, title: s.dataset.title || '', steps },
    elements: app.selection.filter(el => el.isConnected).map(el => {
      const b = boxOf(el);
      let html = el.outerHTML.replace(/ (contenteditable|spellcheck)="[^"]*"/g, '');
      if (html.length > 6000) html = html.slice(0, 6000) + '\n<!-- … truncated … -->';
      return { selector: `section#${s.id} ${selectorFor(el).replace(/^:scope /, '')}`, box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }, html };
    }),
  };
}

async function send() {
  const input = $('#claude-input');
  const prompt = input.value.trim();
  if (!prompt || running || !app.deck) return;
  stopTextEdit();
  await flush(); // Claude must see exactly what is on screen
  input.value = ''; grow();
  const sel = selectionPayload();
  log('user', prompt + (sel.elements.length ? `\n— ${sel.elements.length} selected on slide ${sel.slide.index + 1}` : `\n— slide ${sel.slide.index + 1}`));
  setBusy(true);
  const before = { html: app.html, js: app.js };
  const ctrl = new AbortController();
  running = ctrl;
  let ok = false;
  try {
    const r = await fetch('/api/claude', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Deck': '1' },
      body: JSON.stringify({ deck: app.deck, prompt, selection: sel, model: $('#claude-model').value }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.kind === 'start' && m.resumed) log('info', 'Continuing the conversation (New chat starts fresh).');
        if (m.kind === 'tool') log('tool', `${{ Edit: '✎', Write: '✎', MultiEdit: '✎', Read: '◦', Glob: '◦', Grep: '◦' }[m.name] || '·'} ${m.name} ${m.detail || ''}`);
        if (m.kind === 'text') log('assistant', m.text);
        if (m.kind === 'done') { ok = m.ok; log('info', `${m.ok ? 'Done' : 'Finished with an error'}${m.ms ? ` in ${(m.ms / 1000).toFixed(0)} s` : ''}${m.cost ? ` · $${m.cost.toFixed(3)}` : ''}`); }
        if (m.kind === 'error') log('error', m.message);
        if (m.kind === 'stopped') log('info', 'Stopped.');
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') log('error', e.message);
  } finally {
    running = null;
    // Load whatever Claude changed (even after Stop, edits made so far are on disk) as one undo step.
    const now = await api.get(`/api/deck?deck=${app.deck}`);
    if (now.html !== before.html || now.js !== before.js) {
      app.html = before.html; app.js = before.js;
      await replaceDeck({ html: now.html, js: now.js }, { record: true, write: false, label: 'Claude' });
      log('info', 'Changes loaded. ⌘Z undoes them.');
    } else if (ok) log('info', 'No files changed.');
    setBusy(false);
  }
}

export async function stop() {
  if (!running) return;
  await api.post(`/api/claude/stop?deck=${app.deck}`).catch(() => {});
}

function setBusy(on) {
  app.busy = on;
  $('#busy').hidden = !on;
  $('#claude-send').disabled = on;
  $('#claude-send').textContent = on ? 'Working…' : 'Ask';
}
