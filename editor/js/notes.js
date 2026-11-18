// Speaker notes pane under the slide (like PowerPoint's). Edits the slide's <aside class="notes">, keeping simple
// formatting (bold, italic, lists, paragraphs). The presenter window shows the same notes and can edit them too.
import { app, $, commit, currentSlide } from './app.js';

let timer = null;
const pane = () => $('#notes-edit');
const isEmpty = html => /^(\s|<br\s*\/?>|<p>\s*(<br\s*\/?>)?\s*<\/p>)*$/i.test(html);

export function initNotes() {
  const el = pane();
  app.on('slide', load);
  app.on('frame', load);
  app.on('change', () => { if (document.activeElement !== el) load(); });
  el.addEventListener('focus', () => document.execCommand('defaultParagraphSeparator', false, 'p'));
  el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => store(true), 600); });
  el.addEventListener('blur', () => { clearTimeout(timer); store(true); });
  el.addEventListener('keydown', e => { if (e.key === 'Escape') el.blur(); e.stopPropagation(); });
  el.addEventListener('paste', e => { // plain text, so styles from other apps don't come along
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
}

function load() {
  const s = currentSlide();
  if (!s) return;
  const n = s.querySelector(':scope > .notes');
  const html = n ? n.innerHTML.trim() : '';
  pane().innerHTML = isEmpty(html) ? '' : html;
}

// Writes the pane into the slide; records an undo step when asked.
function store(record) {
  const s = currentSlide();
  if (!s || !app.doc) return;
  let html = pane().innerHTML
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/\s(on\w+|style|class|contenteditable)="[^"]*"/gi, '')
    .replace(/<div>/gi, '<p>').replace(/<\/div>/gi, '</p>')
    .trim();
  if (isEmpty(html)) html = '';
  else if (!/^<(p|ul|ol)\b/i.test(html)) html = `<p>${html}</p>`;
  let n = s.querySelector(':scope > .notes');
  if (!html) { if (n) n.remove(); }
  else {
    if (!n) { n = app.doc.createElement('aside'); n.className = 'notes'; s.append(n); }
    if (n.innerHTML === html) return;
    n.innerHTML = html;
  }
  if (record) commit('Notes');
}
