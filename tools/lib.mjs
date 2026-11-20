// Shared helpers for the build tools and the dev server. Node 20+, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAudience, writeAudience } from '../editor/js/audiences.js'; // shared with the editor

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DECKS = path.join(ROOT, 'decks');
export const DIST = path.join(ROOT, 'dist');
export const TEMPLATES = path.join(ROOT, 'templates');
export const ARCHIVE = path.join(ROOT, 'archive');

export const SLIDES_START = '<!-- ==================== SLIDES ==================== -->';
export const SLIDES_END = '<!-- ==================== END SLIDES ==================== -->';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.txt': 'text/plain; charset=utf-8',
};
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m.split(';')[0], e]));

export const validName = n => /^[a-z0-9][a-z0-9._-]*$/i.test(n || '');
export const deckDir = name => {
  if (!validName(name)) throw new Error(`Invalid deck name: ${name}`);
  return path.join(DECKS, name);
};
export const templateDir = name => {
  if (!validName(name)) throw new Error(`Invalid template name: ${name}`);
  return path.join(TEMPLATES, name);
};

/**
 * The editor and the server address what they edit with a ref: "my-talk" is decks/my-talk, "templates/uni" is a
 * template (templates are edited like decks; their slides are the layouts).
 */
export function resolveRef(ref) {
  const m = /^templates\/(.+)$/.exec(ref || '');
  const kind = m ? 'template' : 'deck', name = m ? m[1] : String(ref || '').replace(/^decks\//, '');
  const dir = m ? templateDir(name) : deckDir(name);
  return { kind, name, dir, rel: `${m ? 'templates' : 'decks'}/${name}` };
}

/** Turns whatever was typed into a standard name: "Mon Été 2026!" → "mon-ete-2026". */
export const deckSlug = (s, fallback = 'deck') => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;

/** Standardises the name and, if <root>/<name> is taken, appends the next free number: talk, talk-2, talk-3, … */
export function freeName(input, root = DECKS, fallback = 'deck') {
  const base = deckSlug(input, fallback);
  let name = base, k = 1;
  while (fs.existsSync(path.join(root, name))) name = `${base}-${++k}`;
  return name;
}
export const freeDeckName = input => freeName(input, DECKS, 'deck');

/* ── Slides, layouts and metadata inside deck.html ── */

export const LAYOUTS_RE = /\n?<template id="deck-layouts">[\s\S]*?<\/template>\n?/;
const titleOf = html => ((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || '').trim();
const metaOf = (html, name) => ((new RegExp(`<meta name="${name}" content="([^"]*)"`, 'i').exec(html) || [])[1] || '');
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The <section class="slide"> elements between the SLIDES markers, as HTML strings. */
export function slidesOf(html) {
  const a = html.indexOf(SLIDES_START), b = html.indexOf(SLIDES_END);
  const region = a >= 0 && b > a ? html.slice(a + SLIDES_START.length, b) : html.replace(LAYOUTS_RE, '');
  const marked = region.split(/<!-- ===== Slide [^>]*===== -->/).map(s => s.trim()).filter(s => s.startsWith('<section'));
  if (marked.length) return marked;
  return region.match(/<section\b[^>]*class="[^"]*\bslide\b[\s\S]*?<\/section>/g) || [];
}
/** The layouts a deck offers under + Slide (copied from its template when the deck was made). */
export const layoutsOf = html => {
  const m = /<template id="deck-layouts">([\s\S]*?)<\/template>/.exec(html);
  return m ? m[1].match(/<section\b[\s\S]*?<\/section>/g) || [] : [];
};
const slideId = s => (/\bid="([^"]*)"/.exec(s) || [])[1] || 'slide';
/** Replaces the slides between the markers, numbering the marker comments. */
export function withSlides(html, sections) {
  const a = html.indexOf(SLIDES_START), b = html.indexOf(SLIDES_END);
  if (a < 0 || b < 0) throw new Error('deck.html has no SLIDES markers');
  const body = sections.map((s, i) => `<!-- ===== Slide ${i + 1} · ${slideId(s)} ===== -->\n${s}`).join('\n\n');
  return html.slice(0, a) + `${SLIDES_START}\n\n${body}\n\n${SLIDES_END}` + html.slice(b + SLIDES_END.length);
}
function setMeta(html, name, content) {
  const tag = `<meta name="${name}" content="${escAttr(content)}">`;
  const re = new RegExp(`<meta name="${name}" content="[^"]*">`, 'i');
  if (re.test(html)) return content ? html.replace(re, tag) : html.replace(new RegExp(`\\n?${re.source}`, 'i'), '');
  return content ? html.replace(/(<title>[^<]*<\/title>)/i, `$1\n${tag}`) : html;
}
const setTitle = (html, title) => html.replace(/<title>[^<]*<\/title>/i, `<title>${String(title).replace(/[<&]/g, '')}</title>`);

function info(dir, name) {
  const file = path.join(dir, 'deck.html');
  const html = fs.readFileSync(file, 'utf8');
  return { name, title: titleOf(html) || name, slides: slidesOf(html).length, modified: fs.statSync(file).mtimeMs, html };
}

/** Decks in decks/ (or archived ones, with root = ARCHIVE), newest first. */
export function listDecks(root = DECKS) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && validName(d.name) && fs.existsSync(path.join(root, d.name, 'deck.html')))
    .map(d => { const { html, ...i } = info(path.join(root, d.name), d.name); return { ...i, template: metaOf(html, 'deck-template'), audience: readAudience(html) }; })
    .sort((a, b) => b.modified - a.modified);
}

/* ── Managing decks: duplicate, archive (archive/<name>/, beside decks/ so relative paths keep working), delete ── */

const existingDeck = (root, name) => {
  if (!validName(name)) throw Object.assign(new Error(`Invalid deck name: ${name}`), { status: 400 });
  const dir = path.join(root, name);
  if (!fs.existsSync(path.join(dir, 'deck.html'))) throw Object.assign(new Error(`"${name}" doesn't exist (any more)`), { status: 404 });
  return dir;
};

/** Copies decks/<name>/ to decks/<name>-copy/ (or -copy-2 …), titled "… (copy)". Returns { name, title }. */
export function duplicateDeck(name) {
  const src = existingDeck(DECKS, name);
  const copy = freeDeckName(`${name}-copy`);
  fs.cpSync(src, deckDir(copy), { recursive: true });
  const file = path.join(deckDir(copy), 'deck.html');
  const title = `${titleOf(fs.readFileSync(file, 'utf8')) || name} (copy)`;
  fs.writeFileSync(file, setTitle(fs.readFileSync(file, 'utf8'), title));
  return { name: copy, title };
}
/** Moves decks/<name>/ to archive/<name>/ (out of the start page and of `npm run build`). Returns the archived name. */
export function archiveDeck(name) {
  const src = existingDeck(DECKS, name);
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const to = freeName(name, ARCHIVE);
  fs.renameSync(src, path.join(ARCHIVE, to));
  return to;
}
/** Moves archive/<name>/ back to decks/ (under a free name). Returns the deck's name. */
export function restoreDeck(name) {
  const src = existingDeck(ARCHIVE, name);
  const to = freeDeckName(name);
  fs.renameSync(src, deckDir(to));
  return to;
}
/** Deletes decks/<name>/ (or archive/<name>/) for good. */
export function deleteDeck(name, { archived = false } = {}) {
  fs.rmSync(existingDeck(archived ? ARCHIVE : DECKS, name), { recursive: true, force: true });
}
/** Deletes templates/<name>/ for good (the default one too). Decks made from it keep their own copy of its design. */
export function deleteTemplate(name) {
  fs.rmSync(existingDeck(TEMPLATES, name), { recursive: true, force: true });
}

/** Templates: { name, title, description, layouts, modified }. The default template comes first. */
export function listTemplates() {
  if (!fs.existsSync(TEMPLATES)) return [];
  return fs.readdirSync(TEMPLATES, { withFileTypes: true })
    .filter(d => d.isDirectory() && validName(d.name) && fs.existsSync(path.join(TEMPLATES, d.name, 'deck.html')))
    .map(d => { const { html, slides, ...i } = info(path.join(TEMPLATES, d.name), d.name); return { ...i, layouts: slides, description: metaOf(html, 'description') }; })
    .sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.title.localeCompare(b.title)));
}

const isLocal = u => u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{)/i.test(u.trim());

function dataUri(file) {
  const mime = (MIME[path.extname(file).toLowerCase()] || 'application/octet-stream').split(';')[0];
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** Bundles decks/<name>/ into one self-contained HTML string (runtime, styles, animations and assets inlined). */
export function bundle(name, { log = () => {} } = {}) {
  const dir = deckDir(name);
  // The layouts are for the editor's + Slide menu only; the built file doesn't need them.
  let html = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8').replace(LAYOUTS_RE, '\n');
  const resolve = (ref, base = dir) => path.resolve(base, decodeURI(ref.split(/[?#]/)[0]));
  const assets = new Map();
  const inline = (ref, base = dir) => {
    if (!isLocal(ref)) return ref;
    const file = resolve(ref, base);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { log(`warning: missing asset ${ref}`); return ref; }
    if (!assets.has(file)) {
      const size = fs.statSync(file).size;
      if (size > 25e6) log(`warning: ${ref} is ${(size / 1e6).toFixed(1)} MB; the single file will be large`);
      assets.set(file, dataUri(file));
    }
    return assets.get(file);
  };
  const cssUrls = (css, base) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => `url("${inline(u, base)}")`);
  const safeScript = js => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

  // Stylesheets → <style>, keeping where they came from.
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, tag => {
    const href = (/href=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!isLocal(href)) return tag;
    const file = resolve(href);
    const css = cssUrls(fs.readFileSync(file, 'utf8'), path.dirname(file));
    const id = href.includes('runtime/deck.css') ? ' id="deck-runtime-css"' : '';
    return `<style${id} data-inline="${href}">\n${css.trim()}\n</style>`;
  });
  // Scripts → inline, with banners so the file stays readable: runtime, then the deck's animations at the bottom.
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, a, src, b) => {
    if (!isLocal(src)) return tag;
    const js = safeScript(fs.readFileSync(resolve(src), 'utf8').trim());
    if (src.includes('runtime/deck.js'))
      return `<!-- ==================== RUNTIME (from runtime/deck.js; edit it there) ==================== -->\n<script id="deck-runtime" data-inline="${src}">\n${js}\n</script>`;
    if (src === 'animations.js')
      return `<!-- ==================== ANIMATIONS (named effects and slide scripts) ==================== -->\n<script id="deck-animations" data-inline="${src}">\n${js}\n</script>`;
    return `<script${a}${b} data-inline="${src}">\n${js}\n</script>`;
  });
  // Assets in attributes and inline CSS. An image the styles use several times (a background shared by many
  // layouts) is inlined once, as a custom property, instead of once per use (not in @font-face, where var() can't go).
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, o, css, c) => {
    css = cssUrls(css, dir);
    const counts = new Map();
    for (const [, d] of css.matchAll(/url\("(data:[^"]{2000,})"\)/g)) counts.set(d, (counts.get(d) || 0) + 1);
    const shared = [...counts].filter(([, n]) => n > 1).map(([d]) => d);
    if (shared.length) {
      css = css.replace(/@font-face\s*\{[^}]*\}|url\("(data:[^"]+)"\)/g, (u, d) => (d && shared.includes(d) ? `var(--deck-asset-${shared.indexOf(d) + 1})` : u));
      css = `\n  :root { ${shared.map((d, i) => `--deck-asset-${i + 1}: url("${d}");`).join(' ')} }` + css;
    }
    return o + css + c;
  });
  html = html.replace(/\s(src|poster|href|data-src)=(["'])([^"']*)\2/gi, (m, attr, q, val) => {
    if (attr.toLowerCase() === 'href' && !/\.(png|jpe?g|gif|webp|svg|mp4|webm|pdf|woff2?|ttf|otf)$/i.test(val)) return m;
    return ` ${attr}=${q}${inline(val)}${q}`;
  });
  html = html.replace(/\sstyle=(["'])([^"']*url\([^"']*)\1/gi, (m, q, css) => ` style=${q}${cssUrls(css, dir).replace(/"/g, "'")}${q}`);
  html = html.replace(/<html\b([^>]*)>/i, (m, a) => `<html${a}>\n<!-- Built with Deckelsmouk from decks/${name}/ on ${new Date().toISOString().slice(0, 10)}. Open in any browser; works offline. -->`);
  return { html, assets: assets.size };
}

/** A built file (string) is one of ours when it carries the runtime banner. */
export const isBuiltDeck = html => /<script id="deck-runtime"/.test(html) && /<div\b[^>]*class="[^"]*\bstage\b/.test(html);

/**
 * Turns a built single-file deck back into editable source (deck.html, animations.js, assets/) in decks/<name>/,
 * or in templates/<name>/ with { into: 'templates' }. Returns the name used.
 */
export function unpack(file, input, { into = 'decks' } = {}) {
  const root = into === 'templates' ? TEMPLATES : DECKS;
  const name = freeName(input, root, into === 'templates' ? 'template' : 'deck');
  const dir = path.join(root, name);
  let html = Buffer.isBuffer(file) ? file.toString('utf8') : fs.readFileSync(file, 'utf8');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  let animations = '/* Animations for this deck. See CLAUDE.md. */\n';
  html = html.replace(/<!-- Built with Deckelsmouk[^>]*-->\n?/, '');
  html = html.replace(/<style id="deck-runtime-css"[^>]*>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="../../runtime/deck.css">');
  html = html.replace(/<!-- =+ RUNTIME[^>]*-->\n?<script id="deck-runtime"[^>]*>[\s\S]*?<\/script>/, '<script src="../../runtime/deck.js"></script>');
  html = html.replace(/<!-- =+ ANIMATIONS[^>]*-->\n?<script id="deck-animations"[^>]*>([\s\S]*?)<\/script>/, (m, js) => {
    animations = js.replace(/<\\\/script/gi, '</script').replace(/<\\!--/g, '<!--').trim() + '\n';
    return '<script src="animations.js"></script>';
  });
  const seen = new Map();
  html = html.replace(/data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi, (m, mime, b64) => {
    if (!seen.has(b64)) {
      const rel = `assets/asset-${seen.size + 1}${EXT[mime] || '.bin'}`;
      fs.writeFileSync(path.join(dir, rel), Buffer.from(b64, 'base64'));
      seen.set(b64, rel);
    }
    return seen.get(b64);
  });
  fs.writeFileSync(path.join(dir, 'deck.html'), html);
  fs.writeFileSync(path.join(dir, 'animations.js'), animations);
  return { assets: seen.size, name };
}

/** Makes a deck's HTML a template's: no layouts block, and every slide has a data-layout (the key its CSS uses) and a name. */
export function asTemplate(html) {
  html = html.replace(LAYOUTS_RE, '\n');
  return withSlides(html, slidesOf(html).map(s => s.replace(/^<section\b([^>]*)>/, (tag, attrs) => {
    if (!/\bdata-layout=/.test(attrs)) attrs += ` data-layout="${slideId(s)}"`;
    if (!/\bdata-title=/.test(attrs)) attrs += ` data-title="${slideId(s)}"`;
    return `<section${attrs}>`;
  })));
}

// Copies a deck or template folder into a new one, leaving out what belongs to the source only: the original of an
// import (source/) and Claude's notes about it (session.md).
const copyFolder = (src, dir) => fs.cpSync(src, dir, {
  recursive: true,
  filter: f => { const rel = path.relative(src, f); return rel.split(path.sep)[0] !== 'source' && rel !== 'session.md'; },
});

/** deck.html with its layouts block (for the + Slide menu) replaced by these layouts, or removed when there are none. */
function withLayouts(html, layouts, from) {
  html = html.replace(LAYOUTS_RE, '\n');
  if (!layouts.length) return html;
  const block = `<template id="deck-layouts">\n<!-- Slide layouts from the template "${escAttr(from)}". The editor's + Slide menu offers them. -->\n${layouts.join('\n\n')}\n</template>\n`;
  // After the stage, before the scripts.
  const end = html.indexOf(SLIDES_END), at = html.indexOf('<script', end);
  return at > end ? html.slice(0, at) + block + html.slice(at) : html.replace(/<\/body>/i, `${block}</body>`);
}

/** The built-in blank deck (tools/blank/), used when there is no template. It can't be deleted with the templates. */
export const BLANK = path.join(ROOT, 'tools', 'blank');
const hasTemplate = name => !!name && validName(name) && fs.existsSync(path.join(TEMPLATES, name, 'deck.html'));
/** What new templates and imports start from: the default template, or the blank deck when it was deleted. */
export const starterDir = () => (hasTemplate('default') ? path.join(TEMPLATES, 'default') : BLANK);

/**
 * Creates decks/<name>/ from a template, like File → New in PowerPoint: the deck gets the template's theme, assets and
 * scripts, starts with the template's first layout, and keeps all layouts for the editor's + Slide menu.
 * Without a template (template: '', or the default one deleted) it starts from the built-in blank deck.
 * Any input is accepted (see freeDeckName); returns the deck's directory.
 */
export function createDeck(input, { template = 'default', title, audience = null } = {}) {
  if (!String(input || '').trim()) throw new Error('Give the deck a name');
  const fromTemplate = hasTemplate(template);
  if (template && !fromTemplate && template !== 'default') throw new Error(`No template "${template}" in templates/`);
  const name = freeDeckName(input);
  const dir = deckDir(name);
  title = title || String(input).trim(); // "My Talk" keeps its spelling as the title
  copyFolder(fromTemplate ? templateDir(template) : BLANK, dir);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const file = path.join(dir, 'deck.html');
  let html = fs.readFileSync(file, 'utf8').replace(LAYOUTS_RE, '\n');
  const layouts = fromTemplate ? slidesOf(html) : [];
  if (!fromTemplate) { // the blank deck: its one slide, and the editor's built-in layouts under + Slide
    html = writeAudience(setMeta(setTitle(html, title), 'deck-template', ''), audience);
    fs.writeFileSync(file, html);
    return dir;
  }
  const first = (layouts[0] || '<section class="slide" id="title" data-title="Title">\n  <aside class="notes"><p></p></aside>\n</section>')
    .replace(/<aside class="notes">[\s\S]*?<\/aside>/, '<aside class="notes"><p></p></aside>'); // notes about the layout don't belong in the deck
  html = withSlides(html, [first]);
  html = withLayouts(html, layouts, titleOf(html) || template);
  html = writeAudience(setMeta(setMeta(setTitle(html, title), 'description', ''), 'deck-template', template), audience);
  fs.writeFileSync(file, html);
  return dir;
}

/**
 * Creates templates/<name>/: a copy of the default template (or of the blank deck when there is none), of another
 * template (from: 'templates/x') or of a deck's design (from: 'my-talk'; its slides become the layouts).
 * Returns the template's name.
 */
export function createTemplate(input, { from, title, description } = {}) {
  if (!String(input || '').trim()) throw new Error('Give the template a name');
  const src = from ? resolveRef(from) : { kind: 'template', dir: starterDir(), rel: 'the default template' };
  if (!fs.existsSync(path.join(src.dir, 'deck.html'))) throw new Error(`Nothing to copy at ${src.rel}`);
  const name = freeName(input, TEMPLATES, 'template');
  const dir = templateDir(name);
  copyFolder(src.dir, dir);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const file = path.join(dir, 'deck.html');
  let html = asTemplate(fs.readFileSync(file, 'utf8'));
  const fromDeck = src.kind === 'deck' ? `Made from the deck ${src.name}` : '';
  html = setMeta(setMeta(setTitle(html, title || String(input).trim()), 'deck-template', ''), 'description', description ?? fromDeck);
  html = writeAudience(html, null); // a template is a design; each deck picks its own audience
  fs.writeFileSync(file, html);
  return name;
}

/* ── Changing a deck's template (by hand, from the editor) ── */

// What kind of layout a key or name describes, to find the closest layout in another template.
const ROLES = [
  ['blank', /blank|empty/], ['title-only', /title[ -]?only/], ['section', /section|chapter|divider|\bpart\b/],
  ['closing', /closing|thank|questions|contact|outro|\bend\b/], ['two', /two|comparison|colum|2[ -]?col/], // not "-2": a variant number
  ['image', /image|picture|photo|media|\bpic/], ['stat', /\bstat|number|kpi|big ?figure/],
  ['title', /^title$|title[ -]?(slide|page)|cover|opening/], ['content', /content|text|bullet|list|body|\bobj/],
];
const roleOf = s => (ROLES.find(([, re]) => re.test(String(s).toLowerCase())) || [])[0] || null;
const attrOf = (s, name) => (new RegExp(`^<section\\b[^>]*\\b${name}="([^"]*)"`).exec(s) || [])[1];

/**
 * Gives decks/<name>/ the design of another template (or of the blank deck with template ''), like choosing another
 * theme in PowerPoint: its theme (#deck-style, fonts included), master, layouts and assets. The slides, their content,
 * animations.js and the audience stay. Each slide keeps its layout where the new template has the same key, else gets
 * the closest one by kind, else the master's look. Template assets whose name is taken by another file in the deck are
 * copied under a new name. Copies the assets and returns { html, report } (the caller saves the html).
 */
export function changeTemplate(name, template) {
  const dir = existingDeck(DECKS, name);
  if (template && !hasTemplate(template)) throw Object.assign(new Error(`No template "${template}"`), { status: 400 });
  const src = template ? templateDir(template) : BLANK;
  const srcHtml = fs.readFileSync(path.join(src, 'deck.html'), 'utf8');
  let html = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');

  // Assets: copy what the deck doesn't have yet; rename on a clash with a different file.
  const renames = [];
  const copy = (from, to, rel = '') => {
    if (!fs.existsSync(from)) return;
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const f = path.join(from, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { copy(f, path.join(to, e.name), r); continue; }
      fs.mkdirSync(to, { recursive: true });
      let target = e.name, k = 1;
      const ext = path.extname(e.name), stem = path.basename(e.name, ext);
      while (fs.existsSync(path.join(to, target)) && !fs.readFileSync(path.join(to, target)).equals(fs.readFileSync(f))) target = `${stem}-${++k}${ext}`;
      if (!fs.existsSync(path.join(to, target))) fs.copyFileSync(f, path.join(to, target));
      if (target !== e.name) renames.push([`assets/${r}`, `assets/${rel ? rel + '/' : ''}${target}`]);
    }
  };
  copy(path.join(src, 'assets'), path.join(dir, 'assets'));
  const relink = s => renames.reduce((t, [a, b]) => t.split(`"${a}"`).join(`"${b}"`).split(`(${a})`).join(`(${b})`), s);

  // Theme and master.
  const style = (/<style id="deck-style">[\s\S]*?<\/style>/.exec(srcHtml) || [])[0];
  if (style) html = html.replace(/<style id="deck-style">[\s\S]*?<\/style>/, () => relink(style));

  // Layouts, and each slide's layout.
  const oldLayouts = new Map(layoutsOf(html).map(l => [attrOf(l, 'data-layout'), attrOf(l, 'data-title') || '']));
  const layouts = template ? slidesOf(srcHtml).map(relink) : [];
  const keys = layouts.map(l => ({ key: attrOf(l, 'data-layout'), role: roleOf(`${attrOf(l, 'data-layout')} ${attrOf(l, 'data-title')}`) })).filter(l => l.key);
  const report = { kept: 0, matched: 0, plain: 0 };
  const slides = slidesOf(html).map(s => s.replace(/^<section\b[^>]*>/, tag => {
    const key = attrOf(tag, 'data-layout');
    if (!key) return tag;
    if (keys.some(l => l.key === key)) { report.kept++; return tag; }
    const role = roleOf(`${key} ${oldLayouts.get(key) || ''}`);
    const match = role && keys.find(l => l.role === role);
    if (match) { report.matched++; return tag.replace(/\bdata-layout="[^"]*"/, `data-layout="${match.key}"`); }
    report.plain++;
    return tag.replace(/\s*\bdata-layout="[^"]*"/, '');
  }));
  html = withSlides(withLayouts(html, layouts, titleOf(srcHtml) || template), slides);
  html = setMeta(html, 'deck-template', template || '');

  // A template with another slide size: the slides keep theirs, but positions were made for the other one.
  const size = h => (/<div class="stage"[^>]*data-width="(\d+)"[^>]*data-height="(\d+)"/.exec(h) || []).slice(1).join(' × ');
  if (size(srcHtml) && size(html) && size(srcHtml) !== size(html)) report.size = `The template is made for ${size(srcHtml)} px slides and this deck has ${size(html)} px: some decorations may not line up.`;
  report.renamed = renames.length;
  return { html, report };
}
