// Fonts that travel with the deck. The Fonts dialog (⋯ → Fonts…, or font files dropped on a slide) uploads files to
// assets/fonts/ and writes their @font-face rules, plus the choice of font for headings and text, into a marked block
// at the end of the theme (#deck-style). The build inlines the files, so the exported deck looks the same everywhere.
import { app, api, deckQuery, replaceDeck, toast } from './app.js';

const BLOCK_RE = /\n?[ \t]*\/\* ── Fonts ──[\s\S]*?\/\* ── End fonts ── \*\/[ \t]*/;
const GENERIC = /^(var\(|-apple-system|system-ui|blinkmacsystemfont|ui-|sans-serif|serif|monospace|inherit|initial)/i;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const styleOf = html => (/<style id="deck-style">([\s\S]*?)<\/style>/.exec(html) || [])[1] || '';
const firstFamily = v => (v || '').split(',')[0].trim().replace(/^["']|["']$/g, '');

/** The deck's managed fonts and what its theme names: { faces, text, heading, themeText, themeHeading, otherFaces }. */
export function readFonts(html) {
  const css = styleOf(html), block = (BLOCK_RE.exec(css) || [''])[0], rest = css.replace(BLOCK_RE, '');
  const prop = (s, re) => (re.exec(s) || [])[1];
  const faces = [...block.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, b]) => ({
    family: prop(b, /font-family:\s*"([^"]+)"/), src: prop(b, /url\("([^"]+)"\)/), format: prop(b, /format\("([^"]+)"\)/) || '',
    weight: (prop(b, /font-weight:\s*([^;]+);/) || '400').trim(), style: (prop(b, /font-style:\s*([^;]+);/) || 'normal').trim(),
  })).filter(f => f.family && f.src);
  return {
    faces,
    text: prop(block, /--font:\s*"([^"]+)"/) || '',
    heading: prop(block, /--font-heading:\s*"([^"]+)"/) || '',
    themeText: firstFamily(prop(rest, /--font:\s*([^;]+);/)),
    themeHeading: firstFamily(prop(rest, /--font-heading:\s*([^;]+);/)),
    otherFaces: [...rest.matchAll(/@font-face\s*\{[^}]*?font-family:\s*["']?([^"';]+)/g)].map(m => m[1].trim()),
  };
}

const SERIF = /serif|georgia|times|garamond|merriweather|playfair|lora|baskerville|caslon|palatino|cambria|crimson|didot|bodoni|minion/i;
const stack = f => `"${f}", ${!/sans/i.test(f) && SERIF.test(f) ? 'Georgia, "Times New Roman", serif' : '"Segoe UI", "Helvetica Neue", Arial, sans-serif'}`;

/** deck.html with the managed fonts block rewritten (or removed when empty). */
export function writeFonts(html, { faces, text, heading }) {
  const lines = faces.map(f => `  @font-face { font-family: "${f.family}"; src: url("${f.src}")${f.format ? ` format("${f.format}")` : ''}; font-weight: ${f.weight}; font-style: ${f.style}; font-display: swap; }`);
  if (text || heading) lines.push(`  :root {${text ? ` --font: ${stack(text)};` : ''}${heading ? ` --font-heading: ${stack(heading)};` : ''} }`);
  if (heading) lines.push('  .hero, .h1, .h2, .h3 { font-family: var(--font-heading); }');
  const block = lines.length ? `\n  /* ── Fonts ── Written by the editor (⋯ → Fonts…); the files are in assets/fonts/ and travel with the deck. */\n${lines.join('\n')}\n  /* ── End fonts ── */\n` : '\n';
  return html.replace(/(<style id="deck-style">)([\s\S]*?)(<\/style>)/, (m, open, css, close) => open + css.replace(BLOCK_RE, '').replace(/\s*$/, '') + block + close);
}

const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
const faceName = f => `${/\s/.test(f.weight) ? `variable ${f.weight.replace(' ', '–')}` : WEIGHT_NAMES[f.weight] || f.weight}${f.style === 'italic' ? ' Italic' : ''}`;

/** The Fonts dialog. `files`: font files to add right away (dropped on a slide). */
export async function openFonts(files = []) {
  const cur = readFonts(app.html);
  const state = { faces: [...cur.faces], text: cur.text, heading: cur.heading };
  const d = document.createElement('dialog');
  d.className = 'dialog wide fonts';
  d.innerHTML = `<form><h3>Fonts</h3>
    <p>Font files travel with the deck, also inside the exported file, so it looks the same on every computer.</p>
    <div class="font-list"></div>
    <div class="font-add"><button type="button" data-add>＋ Add font files…</button><span class="hint">.woff2, .woff, .ttf or .otf, or drop them on a slide</span></div>
    <div class="font-use">
      <label>Headings <select data-k="heading"></select></label>
      <label>Text <select data-k="text"></select></label>
    </div>
    <p class="font-warn" hidden></p>
    <input type="file" multiple accept=".woff2,.woff,.ttf,.otf" hidden>
    <div class="dialog-btns"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Save</button></div></form>`;
  const $ = s => d.querySelector(s);
  const families = () => [...new Set(state.faces.map(f => f.family))];
  const render = () => {
    const fams = families();
    $('.font-list').innerHTML = fams.length ? fams.map(fam => {
      const fs = state.faces.filter(f => f.family === fam);
      return `<div class="font-row"><div><b style="font-family:'${esc(fam)}', sans-serif">${esc(fam)}</b><span>${fs.map(faceName).join(', ')}</span></div><button type="button" data-remove="${esc(fam)}">Remove</button></div>`;
    }).join('') : '<p class="hint">No font files in this deck yet: it uses the theme’s fonts as installed on the computer showing it.</p>';
    for (const k of ['heading', 'text']) {
      const theme = (k === 'heading' ? cur.themeHeading : '') || cur.themeText;
      const sel = $(`[data-k="${k}"]`);
      sel.innerHTML = `<option value="">Theme font${theme && !GENERIC.test(theme) ? ` (${esc(theme)})` : ''}</option>${fams.map(f => `<option${state[k] === f ? ' selected' : ''}>${esc(f)}</option>`).join('')}`;
      sel.value = state[k];
    }
    // Fonts the theme names (and the deck still uses) but doesn't carry.
    const carried = new Set([...fams, ...cur.otherFaces].map(f => f.toLowerCase()));
    const used = [!state.heading && (cur.themeHeading || cur.themeText), !state.text && cur.themeText];
    const missing = [...new Set(used)].filter(f => f && !GENERIC.test(f) && !carried.has(f.toLowerCase()));
    $('.font-warn').hidden = !missing.length;
    $('.font-warn').textContent = missing.length ? `The theme uses ${missing.join(' and ')}, which ${missing.length > 1 ? 'are' : 'is'} not in the deck: it only shows on computers that have it installed. Add its font files here to make it travel.` : '';
    state.faces.forEach(preview);
  };
  // Lets the list show each family in its own font.
  const loaded = new Set();
  const preview = f => {
    if (loaded.has(f.src) || !('FontFace' in window)) return;
    loaded.add(f.src);
    const w = /\s/.test(f.weight) ? f.weight : String(f.weight);
    new FontFace(f.family, `url("${app.base}/${f.src}")`, { weight: w, style: f.style }).load().then(ff => document.fonts.add(ff)).catch(() => {});
  };
  const add = async list => {
    for (const file of list) {
      try {
        const r = await api.post(`/api/font?${deckQuery()}&name=${encodeURIComponent(file.name)}`, file, true);
        if (!state.faces.some(f => f.src === r.path)) state.faces.push({ family: r.family, src: r.path, format: r.format, weight: String(r.weight), style: r.style });
        // A font added for something the theme doesn't name is usually meant for the text.
        const named = [cur.themeText, cur.themeHeading].some(t => t && t.toLowerCase() === r.family.toLowerCase());
        if (!named && !state.text && !state.heading) state.text = r.family;
      } catch (e) { toast(esc(e.message), 6000); }
    }
    render();
  };
  d.addEventListener('click', e => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const fam = rm.dataset.remove;
      state.faces = state.faces.filter(f => f.family !== fam);
      if (state.text === fam) state.text = '';
      if (state.heading === fam) state.heading = '';
      render();
    }
  });
  $('[data-add]').onclick = () => $('input[type=file]').click();
  $('input[type=file]').onchange = e => { add([...e.target.files]); e.target.value = ''; };
  d.addEventListener('dragover', e => e.preventDefault());
  d.addEventListener('drop', e => { e.preventDefault(); add([...(e.dataTransfer?.files || [])]); });
  for (const k of ['heading', 'text']) $(`[data-k="${k}"]`).onchange = e => { state[k] = e.target.value; render(); };
  const done = () => { d.close(); d.remove(); };
  $('[data-cancel]').onclick = done;
  d.addEventListener('cancel', e => { e.preventDefault(); done(); });
  d.addEventListener('mousedown', e => { if (e.target === d) done(); });
  $('form').onsubmit = async e => {
    e.preventDefault();
    const html = writeFonts(app.html, state);
    done();
    if (html === app.html) return;
    await replaceDeck({ html, js: app.js }, { record: true, label: 'Fonts' });
    toast('Fonts saved. They travel with the deck, also in the exported file.');
  };
  document.body.append(d);
  d.showModal();
  render();
  if (files.length) await add(files);
}
