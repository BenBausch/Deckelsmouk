#!/usr/bin/env node
// Deckelsmouk dev server: the visual editor, live reload, saving, building, and the bridge to Claude Code.
// Usage: node tools/server.mjs [--port 4800] [--open]          No dependencies; listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { ROOT, DECKS, DIST, MIME, deckDir, listDecks, bundle, createDeck, validName } from './lib.mjs';

const args = process.argv.slice(2);
const PORT = +(args[args.indexOf('--port') + 1] || process.env.PORT || 4800) || 4800;
const CLAUDE = process.env.DECK_CLAUDE_BIN || 'claude';
const MODEL = process.env.DECK_CLAUDE_MODEL || '';

const hash = s => crypto.createHash('sha1').update(s).digest('hex');
const written = new Map();      // file -> hash of what this server last wrote (to tell own writes from outside edits)
const clients = new Set();      // SSE connections
const runs = new Map();         // deck -> running claude process
const sessions = new Map();     // deck -> claude session id (follow-up prompts keep context)

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
      broadcast({ type: 'change', deck: relRoot[0] === 'decks' ? relRoot[1] : null, file: relRoot.join('/') });
    }, 120));
  };
  try { fs.watch(DECKS, { recursive: true }, (e, rel) => onChange(DECKS, rel)); } catch (e) { console.warn('File watching unavailable:', e.message); }
  try { fs.watch(path.join(ROOT, 'runtime'), (e, rel) => onChange(path.join(ROOT, 'runtime'), rel)); } catch { /* optional */ }
}

/* ── Claude Code bridge ──────────────────────────────────────────────────── */

const SYSTEM = `You are working inside Deckelsmouk, a presentation repository. The user is in the visual editor and asks you to change a deck.
Follow CLAUDE.md in the repository root (deck format, animation API, conventions) exactly.
Edit only files of the deck you are given (deck.html, animations.js, assets/). Never rename or reorder the slide markers by hand unless asked; keep every slide a <section class="slide" id="..."> between the SLIDES markers.
Keep top-level objects absolutely positioned with inline left/top/width in stage pixels so the visual editor can move them.
Make the change, then reply with one or two short sentences saying what you changed. No preamble.`;

function describe(sel) {
  if (!sel) return '';
  const out = [];
  if (sel.slide) out.push(`Current slide: #${sel.slide.index + 1} of ${sel.slide.count}, id="${sel.slide.id}"${sel.slide.title ? `, title "${sel.slide.title}"` : ''}${sel.slide.steps ? `, ${sel.slide.steps} click steps, viewing step ${sel.slide.step ?? 'final'}` : ''}.`);
  if (sel.elements && sel.elements.length) {
    out.push(`Selected object${sel.elements.length > 1 ? 's' : ''} on that slide (selector relative to the slide, box in stage px):`);
    sel.elements.forEach((e, i) => {
      out.push(`${i + 1}. \`${e.selector}\` at x=${e.box.x} y=${e.box.y} w=${e.box.w} h=${e.box.h}\n\`\`\`html\n${e.html}\n\`\`\``);
    });
  } else if (sel.slide) out.push('No object is selected: the request is about the whole slide.');
  return out.join('\n');
}

async function runClaude(req, res) {
  const body = await json(req);
  const deck = body.deck;
  if (!validName(deck) || !fs.existsSync(deckDir(deck))) return fail(res, 400, 'Unknown deck');
  if (runs.has(deck)) return fail(res, 409, 'Claude is already working on this deck');
  if (body.newChat) sessions.delete(deck);

  const prompt = [
    `Deck: decks/${deck}/ (deck.html = slides and styles, animations.js = named effects and slide scripts, assets/ = media).`,
    describe(body.selection),
    '',
    `Request: ${body.prompt}`,
  ].join('\n');

  const argv = ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep,MultiEdit',
    '--append-system-prompt', SYSTEM];
  if (sessions.has(deck)) argv.push('--resume', sessions.get(deck));
  if (body.model || MODEL) argv.push('--model', body.model || MODEL);

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const emit = o => res.write(JSON.stringify(o) + '\n');
  emit({ kind: 'start', resumed: sessions.has(deck) });

  let proc;
  try { proc = spawn(CLAUDE, argv, { cwd: ROOT, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { emit({ kind: 'error', message: e.message }); return res.end(); }
  runs.set(deck, proc);
  broadcast({ type: 'claude', deck, running: true });
  proc.stdin.end(prompt);

  let buf = '', errText = '', gotResult = false;
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.session_id) sessions.set(deck, m.session_id);
      if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
        for (const c of m.message.content) {
          if (c.type === 'text' && c.text.trim()) emit({ kind: 'text', text: c.text });
          if (c.type === 'tool_use') {
            const inp = c.input || {};
            const target = inp.file_path ? path.relative(ROOT, inp.file_path) : inp.pattern || inp.path || '';
            emit({ kind: 'tool', name: c.name, detail: target });
          }
        }
      }
      if (m.type === 'result') {
        gotResult = true;
        emit({ kind: 'done', ok: !m.is_error, result: m.result, cost: m.total_cost_usd, ms: m.duration_ms });
      }
    }
  });
  proc.stderr.on('data', c => { errText += c; });
  proc.on('error', e => {
    emit({ kind: 'error', message: e.code === 'ENOENT' ? `Claude Code CLI not found ("${CLAUDE}"). Install it or set DECK_CLAUDE_BIN.` : e.message });
  });
  proc.on('close', code => {
    runs.delete(deck);
    broadcast({ type: 'claude', deck, running: false });
    if (!gotResult) emit({ kind: code === null ? 'stopped' : 'error', message: code === null ? 'Stopped.' : (errText.trim() || `claude exited with code ${code}`) });
    res.end();
  });
  res.on('close', () => { if (!res.writableFinished && runs.get(deck) === proc) proc.kill('SIGTERM'); });
}

/* ── API ─────────────────────────────────────────────────────────────────── */

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const deck = url.searchParams.get('deck');
  // Writes need a custom header: browsers cannot send it cross-site without a CORS preflight, which this server refuses.
  if (req.method !== 'GET' && req.headers['x-deck'] !== '1') return fail(res, 403, 'Missing X-Deck header');

  switch (route) {
    case 'GET /api/decks': return send(res, 200, listDecks());
    case 'GET /api/templates': return send(res, 200, fs.readdirSync(path.join(ROOT, 'templates')).filter(n => !n.startsWith('.')));
    case 'GET /api/deck': {
      const dir = deckDir(deck);
      const read = f => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
      return send(res, 200, { name: deck, html: read('deck.html'), js: read('animations.js'), running: runs.has(deck) });
    }
    case 'PUT /api/deck': {
      const dir = deckDir(deck);
      const body = await json(req);
      if (typeof body.html === 'string') writeFile(path.join(dir, 'deck.html'), body.html);
      if (typeof body.js === 'string') writeFile(path.join(dir, 'animations.js'), body.js);
      return send(res, 200, { ok: true });
    }
    case 'POST /api/new': {
      const body = await json(req);
      try { createDeck(body.name, { template: body.template || 'default', title: body.title }); }
      catch (e) { return fail(res, 400, e.message); }
      return send(res, 200, { ok: true, name: body.name });
    }
    case 'POST /api/upload': {
      const dir = path.join(deckDir(deck), 'assets');
      fs.mkdirSync(dir, { recursive: true });
      const orig = path.basename(url.searchParams.get('name') || 'file').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      const ext = path.extname(orig), stem = path.basename(orig, ext) || 'file';
      let name = stem + ext, k = 1;
      while (fs.existsSync(path.join(dir, name))) name = `${stem}-${++k}${ext}`;
      fs.writeFileSync(path.join(dir, name), await readBody(req));
      return send(res, 200, { path: `assets/${name}` });
    }
    case 'POST /api/build': {
      const { html, assets } = bundle(deck, { log: m => console.log(`  ${deck}: ${m}`) });
      fs.mkdirSync(DIST, { recursive: true });
      fs.writeFileSync(path.join(DIST, `${deck}.html`), html);
      return send(res, 200, { path: `/dist/${deck}.html`, kb: Math.round(Buffer.byteLength(html) / 1024), assets });
    }
    case 'POST /api/claude': return runClaude(req, res);
    case 'POST /api/claude/stop': {
      const p = runs.get(deck);
      if (p) p.kill('SIGTERM');
      return send(res, 200, { ok: !!p });
    }
    case 'POST /api/claude/reset': sessions.delete(deck); return send(res, 200, { ok: true });
    case 'POST /api/reveal': {
      const f = path.join(deckDir(deck), url.searchParams.get('file') === 'js' ? 'animations.js' : 'deck.html');
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
  if (!file.startsWith(ROOT + path.sep) || !['editor', 'runtime', 'decks', 'dist', 'templates'].includes(top)) return fail(res, 404, 'Not found');
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
    console.error(e);
    if (!res.headersSent) fail(res, 500, e.message); else res.end();
  }
});

watch();
server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}/`;
  console.log(`Deckelsmouk editor: ${link}`);
  if (args.includes('--open')) execFile('open', [link], () => {});
});
