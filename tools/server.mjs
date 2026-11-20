#!/usr/bin/env node
// Deckelsmouk dev server: the visual editor, live reload, saving, building, and the bridge to Claude Code.
// Usage: node tools/server.mjs [--port 4800] [--open]          No dependencies; listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { ROOT, DECKS, DIST, TEMPLATES, ARCHIVE, MIME, resolveRef, listDecks, listTemplates, bundle, createDeck, createTemplate,
  duplicateDeck, archiveDeck, restoreDeck, deleteDeck, deleteTemplate } from './lib.mjs';
import { importPresentation } from './importer.mjs';
import { createBridge, ensureSessionNotes } from './bridge.mjs';
import { snapshot, versions, version, forgetHistory } from './history.mjs';
import { fontInfo } from './fonts.mjs';

const args = process.argv.slice(2);
const PORT = +(args[args.indexOf('--port') + 1] || process.env.PORT || 4800) || 4800;

const hash = s => crypto.createHash('sha1').update(s).digest('hex');
const written = new Map();      // file -> hash of what this server last wrote (to tell own writes from outside edits)
const clients = new Set();      // SSE connections

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const fail = (res, code, msg) => send(res, code, { error: msg });

function readBody(req, limit = 200e6) {
  return new Promise((ok, bad) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { bad(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
}
const json = async req => JSON.parse((await readBody(req)).toString('utf8') || '{}');

function writeFile(file, text) {
  fs.writeFileSync(file, text);
  written.set(file, hash(text));
}

function broadcast(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) c.write(line);
}

/* ── Live reload: tell editors when deck files change outside the editor (Claude, VS Code, git) ── */

const pending = new Map();
function watch() {
  fs.mkdirSync(DECKS, { recursive: true });
  const onChange = (base, rel) => {
    if (!rel) return;
    const file = path.join(base, rel);
    clearTimeout(pending.get(file));
    pending.set(file, setTimeout(() => {
      pending.delete(file);
      let text = null;
      try { text = fs.readFileSync(file, 'utf8'); } catch { /* deleted */ }
      if (text !== null && written.get(file) === hash(text)) return; // our own write
      const relRoot = path.relative(ROOT, file).split(path.sep);
      // Decks are addressed by name, templates as templates/<name> (see resolveRef).
      const deck = relRoot[0] === 'decks' ? relRoot[1] : relRoot[0] === 'templates' ? `templates/${relRoot[1]}` : null;
      broadcast({ type: 'change', deck, file: relRoot.join('/') });
    }, 120));
  };
  try { fs.watch(DECKS, { recursive: true }, (e, rel) => onChange(DECKS, rel)); } catch (e) { console.warn('File watching unavailable:', e.message); }
  try { fs.watch(TEMPLATES, { recursive: true }, (e, rel) => onChange(TEMPLATES, rel)); } catch { /* optional */ }
  try { fs.watch(path.join(ROOT, 'runtime'), (e, rel) => onChange(path.join(ROOT, 'runtime'), rel)); } catch { /* optional */ }
}

/* ── Claude Code bridge (tools/bridge.mjs): one long-lived conversation per deck, plus its session.md ── */

const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const bridge = createBridge({
  broadcast, writeFile, fail,
  // Every Claude request can be taken back from the History panel.
  beforeRequest: (target, body) => snapshot(body.deck, target.dir, `Before Claude: ${oneLine(body.prompt, 90)}`),
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { bridge.stopAll(); process.exit(0); });

/* ── API ─────────────────────────────────────────────────────────────────── */

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  // What to work on: a deck name ("my-talk") or a template ("templates/uni"). See resolveRef in lib.mjs.
  const deck = url.searchParams.get('deck');
  const target = () => {
    const t = resolveRef(deck);
    if (!fs.existsSync(path.join(t.dir, 'deck.html'))) throw Object.assign(new Error(`No deck or template "${deck}"`), { status: 404 });
    return t;
  };
  // Writes need a custom header: browsers cannot send it cross-site without a CORS preflight, which this server refuses.
  if (req.method !== 'GET' && req.headers['x-deck'] !== '1') return fail(res, 403, 'Missing X-Deck header');

  switch (route) {
    case 'GET /api/decks': return send(res, 200, listDecks(url.searchParams.has('archived') ? ARCHIVE : DECKS));
    // Managing decks from the start page. A deck Claude is working on stays where it is.
    case 'POST /api/deck/duplicate': return send(res, 200, { ok: true, ...duplicateDeck(deck) });
    case 'POST /api/deck/archive':
    case 'POST /api/deck/restore':
    case 'DELETE /api/deck': {
      if (bridge.isRunning(deck)) return fail(res, 409, 'Claude is working on this deck; wait or stop it first.');
      await bridge.forget(deck); // its conversation goes; session.md moves with the deck
      if (route === 'POST /api/deck/archive') return send(res, 200, { ok: true, name: archiveDeck(deck) });
      if (route === 'POST /api/deck/restore') return send(res, 200, { ok: true, name: restoreDeck(deck) });
      deleteDeck(deck, { archived: url.searchParams.has('archived') });
      forgetHistory(deck);
      return send(res, 200, { ok: true });
    }
    case 'GET /api/templates': return send(res, 200, listTemplates());
    case 'DELETE /api/template': {
      const name = url.searchParams.get('name');
      if (bridge.isRunning(`templates/${name}`)) return fail(res, 409, 'Claude is working on this template; wait or stop it first.');
      await bridge.forget(`templates/${name}`);
      deleteTemplate(name);
      forgetHistory(`templates/${name}`);
      return send(res, 200, { ok: true });
    }
    case 'GET /api/deck': {
      const t = target();
      const read = f => (fs.existsSync(path.join(t.dir, f)) ? fs.readFileSync(path.join(t.dir, f), 'utf8') : '');
      const source = t.kind === 'template' && fs.existsSync(path.join(t.dir, 'source')) ? fs.readdirSync(path.join(t.dir, 'source')) : [];
      return send(res, 200, { name: deck, kind: t.kind, html: read('deck.html'), js: read('animations.js'), running: bridge.isRunning(deck), source });
    }
    case 'PUT /api/deck': {
      const { dir } = target();
      const body = await json(req);
      if (typeof body.html === 'string') writeFile(path.join(dir, 'deck.html'), body.html);
      if (typeof body.js === 'string') writeFile(path.join(dir, 'animations.js'), body.js);
      return send(res, 200, { ok: true });
    }
    case 'POST /api/new': {
      const body = await json(req);
      let dir;
      // template: '' starts from the built-in blank deck.
      try { dir = createDeck(body.name, { template: body.template ?? 'default', title: body.title, audience: body.audience }); }
      catch (e) { return fail(res, 400, e.message); }
      return send(res, 200, { ok: true, name: path.basename(dir) });
    }
    // A new template: a copy of the default one, of another template ("templates/x") or of a deck's design ("my-talk").
    case 'POST /api/template': {
      const body = await json(req);
      try { return send(res, 200, { ok: true, name: createTemplate(body.name, { from: body.from, title: body.title }) }); }
      catch (e) { return fail(res, 400, e.message); }
    }
    // A dropped presentation (raw body; ?name=<file name>) becomes a template. See tools/importer.mjs.
    case 'POST /api/import': {
      const file = path.basename(url.searchParams.get('name') || 'presentation');
      try { return send(res, 200, { ok: true, ...importPresentation(await readBody(req), file) }); }
      catch (e) { return fail(res, 400, e.message); }
    }
    case 'POST /api/upload': {
      const dir = path.join(target().dir, 'assets');
      fs.mkdirSync(dir, { recursive: true });
      const orig = path.basename(url.searchParams.get('name') || 'file').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      const ext = path.extname(orig), stem = path.basename(orig, ext) || 'file';
      let name = stem + ext, k = 1;
      while (fs.existsSync(path.join(dir, name))) name = `${stem}-${++k}${ext}`;
      fs.writeFileSync(path.join(dir, name), await readBody(req));
      return send(res, 200, { path: `assets/${name}` });
    }
    // A font file for the deck: stored in assets/fonts/ and described from its own tables (tools/fonts.mjs).
    case 'POST /api/font': {
      const t = target(), file = path.basename(url.searchParams.get('name') || 'font');
      const buf = await readBody(req, 40e6);
      let info;
      try { info = fontInfo(buf, file); } catch (e) { return fail(res, 400, e.message); }
      const dir = path.join(t.dir, 'assets', 'fonts');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(file).toLowerCase(), stem = path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'font';
      let name = stem + ext, k = 1;
      while (fs.existsSync(path.join(dir, name)) && !fs.readFileSync(path.join(dir, name)).equals(buf)) name = `${stem}-${++k}${ext}`;
      fs.writeFileSync(path.join(dir, name), buf);
      return send(res, 200, { ok: true, path: `assets/fonts/${name}`, ...info });
    }
    case 'POST /api/build': {
      const t = target();
      if (t.kind !== 'deck') return fail(res, 400, 'Templates are not exported. Make a deck from it first.');
      const { html, assets } = bundle(t.name, { log: m => console.log(`  ${t.name}: ${m}`) });
      fs.mkdirSync(DIST, { recursive: true });
      fs.writeFileSync(path.join(DIST, `${t.name}.html`), html);
      return send(res, 200, { path: `/dist/${t.name}.html`, kb: Math.round(Buffer.byteLength(html) / 1024), assets });
    }
    // Version history (tools/history.mjs).
    case 'GET /api/history': target(); return send(res, 200, versions(deck));
    case 'POST /api/history/snapshot': {
      const v = snapshot(deck, target().dir, oneLine(url.searchParams.get('label') || 'Saved', 90));
      return send(res, 200, { ok: true, version: v });
    }
    case 'POST /api/history/restore': {
      const t = target(), v = version(deck, url.searchParams.get('id'));
      const when = new Date(versions(deck).find(e => e.id === url.searchParams.get('id'))?.time || Date.now());
      snapshot(deck, t.dir, `Before restoring the version of ${when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`);
      writeFile(path.join(t.dir, 'deck.html'), v.html);
      writeFile(path.join(t.dir, 'animations.js'), v.js);
      return send(res, 200, { ok: true, html: v.html, js: v.js });
    }
    // A version as a page (slide thumbnails), for the History panel's preview.
    case 'GET /api/history/view': {
      const t = target(), v = version(deck, url.searchParams.get('id'));
      const zoom = Math.min(1, Math.max(0.05, +url.searchParams.get('zoom') || 0.2));
      const html = v.html.replace(/<head>/i, `<head>\n<base href="/${t.rel.split('/').map(encodeURIComponent).join('/')}/">\n<style>:root { --thumb-zoom: ${zoom}; color-scheme: dark; } html, body { background: transparent !important; } .slide.is-current { outline-color: transparent !important; } .slide.is-current::after { background: rgba(20,22,26,.82) !important; color: #c9ced6 !important; }</style>`);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    case 'POST /api/claude': return bridge.run(res, await json(req));
    case 'POST /api/claude/stop': return send(res, 200, { ok: bridge.stop(deck) });
    case 'POST /api/claude/reset': await bridge.forget(deck); return send(res, 200, { ok: true });
    case 'POST /api/reveal': {
      const t = target(), which = url.searchParams.get('file');
      const f = which === 'session' ? ensureSessionNotes(t.dir, t.kind) : path.join(t.dir, which === 'js' ? 'animations.js' : 'deck.html');
      execFile('code', ['-g', f], err => { if (err) execFile('open', [f], () => {}); });
      return send(res, 200, { ok: true });
    }
    case 'GET /api/events': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
  }
  return fail(res, 404, 'Not found');
}

/* ── Static files ────────────────────────────────────────────────────────── */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '/editor' || rel === '/editor/') rel = '/editor/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || !['editor', 'runtime', 'decks', 'dist', 'templates', 'archive'].includes(top)) return fail(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) { // videos need ranges in Safari
      const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Only answer requests addressed to this machine (blocks DNS-rebinding pages).
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return fail(res, 403, 'Forbidden host');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.message); else res.end();
  }
});

watch();
server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}/`;
  console.log(`Deckelsmouk editor: ${link}`);
  if (args.includes('--open')) execFile('open', [link], () => {});
});
