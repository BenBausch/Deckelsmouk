// Shared helpers for the build tools and the dev server. Node 20+, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DECKS = path.join(ROOT, 'decks');
export const DIST = path.join(ROOT, 'dist');
export const TEMPLATES = path.join(ROOT, 'templates');

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

export function listDecks() {
  if (!fs.existsSync(DECKS)) return [];
  return fs.readdirSync(DECKS, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(DECKS, d.name, 'deck.html')))
    .map(d => {
      const file = path.join(DECKS, d.name, 'deck.html');
      const html = fs.readFileSync(file, 'utf8');
      return {
        name: d.name,
        title: (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || d.name,
        slides: (html.match(/<section\b[^>]*class="[^"]*\bslide\b/g) || []).length,
        modified: fs.statSync(file).mtimeMs,
      };
    })
    .sort((a, b) => b.modified - a.modified);
}

const isLocal = u => u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{)/i.test(u.trim());

function dataUri(file) {
  const mime = (MIME[path.extname(file).toLowerCase()] || 'application/octet-stream').split(';')[0];
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** Bundles decks/<name>/ into one self-contained HTML string (runtime, styles, animations and assets inlined). */
export function bundle(name, { log = () => {} } = {}) {
  const dir = deckDir(name);
  let html = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
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
  // Assets in attributes and inline CSS.
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, o, css, c) => o + cssUrls(css, dir) + c);
  html = html.replace(/\s(src|poster|href|data-src)=(["'])([^"']*)\2/gi, (m, attr, q, val) => {
    if (attr.toLowerCase() === 'href' && !/\.(png|jpe?g|gif|webp|svg|mp4|webm|pdf|woff2?|ttf|otf)$/i.test(val)) return m;
    return ` ${attr}=${q}${inline(val)}${q}`;
  });
  html = html.replace(/\sstyle=(["'])([^"']*url\([^"']*)\1/gi, (m, q, css) => ` style=${q}${cssUrls(css, dir).replace(/"/g, "'")}${q}`);
  html = html.replace(/<html\b([^>]*)>/i, (m, a) => `<html${a}>\n<!-- Built with Deckelsmouk from decks/${name}/ on ${new Date().toISOString().slice(0, 10)}. Open in any browser; works offline. -->`);
  return { html, assets: assets.size };
}

/** Turns a built single-file deck back into decks/<name>/ (deck.html, animations.js, assets/). */
export function unpack(file, name) {
  const dir = deckDir(name);
  if (fs.existsSync(dir)) throw new Error(`decks/${name} already exists`);
  let html = fs.readFileSync(file, 'utf8');
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
  return { assets: seen.size };
}

export function createDeck(name, { template = 'default', title } = {}) {
  const dir = deckDir(name);
  if (fs.existsSync(dir)) throw new Error(`decks/${name} already exists`);
  const src = path.join(TEMPLATES, template);
  if (!fs.existsSync(src)) throw new Error(`No template "${template}" in templates/`);
  fs.cpSync(src, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const file = path.join(dir, 'deck.html');
  const html = fs.readFileSync(file, 'utf8').replace(/<title>[^<]*<\/title>/, `<title>${(title || name).replace(/[<&]/g, '')}</title>`);
  fs.writeFileSync(file, html);
  return dir;
}
