// Turns a dropped presentation into a template in templates/<name>/.
// PowerPoint files (.pptx, .potx) are converted right here (pptx.mjs). A deck built with Deckelsmouk is unpacked.
// Anything else that has a look worth copying (HTML, PDF, a .zip of an HTML presentation) becomes a copy of the
// default template plus the original in source/, and a prompt for Claude to restyle it.
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATES, templateDir, freeName, createTemplate, unpack, isBuiltDeck, asTemplate, starterDir } from './lib.mjs';
import { pptxToTemplate } from './pptx.mjs';
import { readZip } from './ooxml.mjs';

const POWERPOINT = new Set(['.pptx', '.potx', '.ppsx', '.pptm', '.potm', '.ppsm']);
const RESAVE = 'This is the old binary PowerPoint format. Open it in PowerPoint and save it as .pptx (File → Save As), then drop that.';
const ASK = {
  '.ppt': RESAVE, '.pot': RESAVE, '.pps': RESAVE,
  '.key': "Keynote files can't be read directly. In Keynote choose File → Export To → PowerPoint, then drop the .pptx.",
  '.odp': 'In LibreOffice Impress choose File → Save As → PowerPoint (.pptx), then drop that.',
  '.otp': 'In LibreOffice Impress open the template, choose File → Save As → PowerPoint (.pptx), then drop that.',
};
export const IMPORT_ACCEPT = '.pptx,.potx,.ppsx,.pptm,.potm,.html,.htm,.pdf,.zip';

const label = file => path.basename(file, path.extname(file)).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
const safeFile = file => path.basename(file).replace(/[^\w.() -]+/g, '-') || 'original';

/**
 * Imports a presentation (a Buffer and its file name) as a new template.
 * Returns { name, kind, report?, prompt? }: prompt is set when Claude should finish the job.
 */
export function importPresentation(buf, filename, { name, title } = {}) {
  const ext = path.extname(filename).toLowerCase();
  if (ASK[ext]) throw new Error(ASK[ext]);
  const pretty = title || label(filename) || 'Imported template';
  const keep = dir => {
    fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
    const rel = `source/${safeFile(filename)}`;
    fs.writeFileSync(path.join(dir, rel), buf);
    return rel;
  };

  if (POWERPOINT.has(ext)) {
    const tname = freeName(name || pretty, TEMPLATES, 'template');
    const dir = templateDir(tname);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const report = pptxToTemplate(buf, dir, { title: pretty, source: path.basename(filename) });
      fs.copyFileSync(path.join(starterDir(), 'animations.js'), path.join(dir, 'animations.js'));
      const rel = keep(dir);
      extractDesignParts(buf, path.join(dir, 'source', 'pptx'));
      fs.writeFileSync(path.join(dir, 'source', 'import-report.md'), reportText(report, filename));
      return { name: tname, kind: 'pptx', report, source: rel };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`Couldn't read ${path.basename(filename)}: ${e.message}`);
    }
  }

  if ((ext === '.html' || ext === '.htm') && isBuiltDeck(buf.toString('utf8'))) {
    const { name: tname } = unpack(buf, name || pretty, { into: 'templates' });
    const dir = templateDir(tname);
    const file = path.join(dir, 'deck.html');
    let html = asTemplate(fs.readFileSync(file, 'utf8'));
    html = html.replace(/<meta name="deck-template"[^>]*>\n?/, '');
    if (!/<meta name="description"/.test(html)) html = html.replace(/(<\/title>)/, `$1\n<meta name="description" content="Imported from ${safeFile(filename)}">`);
    fs.writeFileSync(file, html);
    const rel = keep(dir);
    return { name: tname, kind: 'deck', source: rel, prompt: deckPrompt(tname, rel) };
  }

  if (['.html', '.htm', '.pdf', '.zip'].includes(ext)) {
    const tname = createTemplate(name || pretty, { title: pretty, description: `Imported from ${safeFile(filename)}` });
    const dir = templateDir(tname);
    let rel, copied = [];
    if (ext === '.zip') {
      rel = `source/${label(filename).replace(/[^\w.-]+/g, '-') || 'original'}`;
      const n = extractZip(buf, path.join(dir, rel));
      if (!n) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('The .zip is empty.'); }
      copied = copyMedia(path.join(dir, rel), dir);
    } else {
      rel = keep(dir);
      if (ext !== '.pdf') copied = extractDataUris(buf.toString('utf8'), dir);
    }
    return { name: tname, kind: ext.slice(1), source: rel, prompt: restylePrompt(tname, rel, ext, copied) };
  }

  throw new Error(`Can't import ${ext ? ext.slice(1).toUpperCase() + ' files' : 'this file'}. Drop a PowerPoint file (.pptx or .potx), an HTML presentation (or a .zip of one) or a PDF.`);
}

// The theme, master and layout XML, one tag per line, so Claude can compare the template with the original.
function extractDesignParts(buf, out) {
  for (const [name, read] of readZip(buf)) {
    if (!/^ppt\/(presentation\.xml|(theme|slideMasters|slideLayouts)\/(_rels\/)?[^/]+\.xml(\.rels)?)$/.test(name)) continue;
    const file = path.join(out, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, read().toString('utf8').replace(/>\s*</g, '>\n<'));
  }
}

function extractZip(buf, out) {
  let n = 0, total = 0;
  for (const [name, read] of readZip(buf)) {
    const parts = name.split('/').filter(Boolean);
    if (!parts.length || parts.some(p => p === '..' || p.includes('\\')) || parts[0] === '__MACOSX' || parts.at(-1).startsWith('._')) continue;
    const data = read();
    total += data.length;
    if (total > 500e6 || n > 5000) throw new Error('The .zip is too large to import.');
    const file = path.join(out, ...parts);
    if (!file.startsWith(out + path.sep)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    n++;
  }
  return n;
}

// Claude edits with text tools and can't copy binary files, so the original's pictures and fonts are put into
// assets/ here; the prompt lists them. Returns [{ to: 'assets/…', from }].
const MEDIA_FILE = /\.(png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf)$/i;
function uniqueAsset(dir, name) {
  const ext = path.extname(name).toLowerCase(), stem = path.basename(name, path.extname(name)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'asset';
  let file = stem + ext, i = 1;
  while (fs.existsSync(path.join(dir, 'assets', file))) file = `${stem}-${++i}${ext}`;
  return file;
}
function copyMedia(src, dir, limit = 80, maxBytes = 40e6) {
  const out = [];
  let bytes = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (MEDIA_FILE.test(e.name) && out.length < limit && (bytes += fs.statSync(f).size) <= maxBytes) {
        const to = uniqueAsset(dir, e.name);
        fs.copyFileSync(f, path.join(dir, 'assets', to));
        out.push({ to: `assets/${to}`, from: path.relative(dir, f).split(path.sep).join('/') });
      }
    }
  };
  walk(src);
  return out;
}
const DATA_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp', 'image/avif': '.avif', 'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf', 'application/font-woff': '.woff', 'application/font-woff2': '.woff2' };
function extractDataUris(html, dir, limit = 80) {
  const out = [], seen = new Set();
  for (const [, mime, b64] of html.matchAll(/data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]{1400,})/gi)) {
    const ext = DATA_EXT[mime.toLowerCase()];
    if (!ext || seen.has(b64) || out.length >= limit) continue;
    seen.add(b64);
    const to = uniqueAsset(dir, `original-${out.length + 1}${ext}`);
    fs.writeFileSync(path.join(dir, 'assets', to), Buffer.from(b64, 'base64'));
    out.push({ to: `assets/${to}`, from: `embedded ${mime} #${out.length + 1}` });
  }
  return out;
}

function reportText(r, filename) {
  return `# Import report: ${path.basename(filename)}

- Slide size: ${r.size} stage px
- Layouts (${r.layouts.length}): ${r.layouts.map(l => `${l.name} (\`${l.key}\`)`).join(', ')}
- Theme colours: ${Object.entries(r.colors).map(([k, v]) => `${k} ${v}`).join(', ')}
- Fonts: ${r.fonts.join(', ') || '(theme fonts not set)'}
- Images copied to assets/: ${r.images}
- Slides in the file: ${r.slides} (a template takes the design only, not the slides)
${r.warnings.length ? `\n## Notes\n\n${r.warnings.map(w => `- ${w}`).join('\n')}\n` : ''}
The original's theme, master and layouts are in source/pptx/ (XML), for comparing.
`;
}

const TEMPLATE_RULES = `A template is a deck whose slides are its layouts (see "Templates" in CLAUDE.md):
- Theme: the :root tokens in #deck-style (--bg --fg --muted --line --accent --accent-2 … --font --font-heading) and the type classes (.hero .h1 .h2 .h3 .lead .body .list .small).
- Master: whatever repeats on every slide (logo, bars, lines, background picture or colour) is drawn by the background of .slide in #deck-style, as CSS background layers (url("assets/…") with px position / size, linear-gradient(…) for bars), not as elements on the slides. A layout with its own background or decorations gets a .slide[data-layout="…"] rule.
- Layouts: each slide is one layout with a unique id, data-layout (the key its CSS uses) and data-title (its name, shown in the + Slide menu). Short placeholder text in the theme classes; image areas are <div class="ph-image" data-el="image">.`;

function restylePrompt(name, rel, ext, copied = []) {
  const how = ext === '.pdf' ? 'Look at its pages (read the PDF).'
    : ext === '.zip' ? 'It is a folder: find the presentation (usually index.html) and read it with its CSS.'
      : 'Read it (its CSS is usually inside).';
  const media = copied.length
    ? `Its pictures and fonts are already in the template's assets/ (use them from there; unused ones are never exported):\n${copied.slice(0, 40).map(c => `- ${c.to}  ← ${c.from}`).join('\n')}${copied.length > 40 ? `\n- … and ${copied.length - 40} more` : ''}`
    : ext === '.pdf' ? 'Pictures can\'t be taken out of a PDF: if it has a logo, leave a clearly named spot for it (a commented background layer) and say so.' : '';
  return `Turn the template templates/${name}/ into a template with the look of the presentation in templates/${name}/${rel}. ${how}
Right now the template is a copy of the default one. Replace its design with the original's:
1. Theme: its colours and fonts in the :root tokens; its typography in the type classes. Font files in assets/ get an @font-face rule; other fonts are named with sensible fallbacks.
2. Master: its recurring elements (logo, bars, lines, footer, background) as background layers of .slide.
3. Layouts: replace the slides with the layouts the original uses: at least title, section header, title + text, title + bullets, two columns, image + text and closing, plus any distinctive layout it has. Placeholder text, not the original's content.
${media ? media + '\n' : ''}${TEMPLATE_RULES}
Stay faithful to the original's look. Work only in templates/${name}/.`;
}

function deckPrompt(name, rel) {
  return `templates/${name}/ was unpacked from a deck built with Deckelsmouk (${rel}). Its slides are still that deck's content. Turn them into reusable layouts:
keep the theme and decorations, keep one slide per distinct layout (title, section, content, …), replace their content with short placeholder text, give each a clear data-title and data-layout, and move anything that repeats on every slide into the background of .slide.
${TEMPLATE_RULES}
Work only in templates/${name}/.`;
}
