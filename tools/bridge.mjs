// The bridge to Claude Code. Fast follow-ups:
// - One long-lived Claude per deck (streaming input): a follow-up continues the same conversation in the same
//   process, with no start-up and no reloading. The conversation id is kept in .deckelsmouk/sessions.json, so it
//   survives restarts of the dev server (a new process resumes it). New chat starts over.
// - session.md in the deck's folder is its memory across conversations: it goes into the first prompt of every new
//   conversation, Claude adds what's worth keeping, and the bridge logs each request at its end.
// - Every prompt carries an outline of the deck with line numbers, so Claude reads just the lines it needs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, SLIDES_START, SLIDES_END, resolveRef, layoutsOf } from './lib.mjs';
import { readAudience, audienceGuide, audienceLabel, readDuration, slideCount } from '../editor/js/audiences.js';

const CLAUDE = process.env.DECK_CLAUDE_BIN || 'claude';
const MODEL = process.env.DECK_CLAUDE_MODEL || '';
const TOOLS = 'Read,Edit,Write,Glob,Grep';
const IDLE_MS = 20 * 60 * 1000;    // an idle Claude stops after this; the next request resumes the conversation
const STORE = path.join(ROOT, '.deckelsmouk', 'sessions.json');

const SYSTEM = `You are working inside Deckelsmouk, a presentation repository. The user is in the visual editor and asks you to change a deck. This conversation continues across their requests.
CLAUDE.md (deck format, animation API, conventions) is already in your context: follow it exactly, don't read it again.
Work fast:
- Each request lists the deck's slides with their line numbers in deck.html. Read only the lines you need (Read with offset and limit), never the whole file unless the request is about the whole deck. The user edits the deck between requests, so read those lines again before editing them.
- Read animations.js only when the request involves effects or slide scripts. Don't explore other folders.
Edit only files of the deck or template you are given (deck.html, animations.js, assets/, session.md). Never rename or reorder the slide markers by hand unless asked; keep every slide a <section class="slide" id="..."> between the SLIDES markers.
Keep top-level objects absolutely positioned with inline left/top/width in stage pixels so the visual editor can move them.
session.md in the deck's folder is its memory across conversations (you get it when a conversation starts). When you learn something worth keeping (what the deck is for, its audience, a style decision, a preference or a "don't" from the user), add it in a line to the right section of session.md in the same turn. Leave its Log section alone: the editor writes it.
Make the change, then reply with one or two short sentences saying what you changed. No preamble.`;

const HEADER = {
  deck: rel => `Deck: ${rel}/ (deck.html = slides and styles, animations.js = named effects and slide scripts, assets/ = media, session.md = notes).`,
  template: rel => `Template: ${rel}/ (a template: its slides are the layouts that new decks start from and offer under + Slide; see "Templates" in CLAUDE.md. deck.html = layouts and styles, animations.js = effects and slide scripts, assets/ = media, source/ = the original it was imported from, if any, session.md = notes).`,
};

/* ── session.md ── */

const skeleton = kind => `# Session notes

Claude's memory of this ${kind} across conversations: it reads this when a conversation starts and adds what is
worth keeping. Edit it freely; keep it short.

## About

## Decisions and preferences

## Notes

## Log
`;
export const sessionFile = dir => path.join(dir, 'session.md');
export function ensureSessionNotes(dir, kind = 'deck') {
  const file = sessionFile(dir);
  if (!fs.existsSync(file)) fs.writeFileSync(file, skeleton(kind));
  return file;
}
const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const stamp = () => { const d = new Date(), p = v => String(v).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/* ── What the deck looks like right now: slides with line numbers, effects and scripts ── */

function outline(dir, sel) {
  const html = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  const lines = html.split('\n');
  const a = lines.findIndex(l => l.includes(SLIDES_START)), b = lines.findIndex(l => l.includes(SLIDES_END));
  const stop = b < 0 ? lines.length : b;
  const slides = [];
  for (let i = Math.max(0, a); i < stop; i++) {
    const m = /<section\b[^>]*\bclass="[^"]*\bslide\b[^"]*"[^>]*>/.exec(lines[i]);
    if (m) slides.push({ start: i + 1, tag: m[0] });
  }
  slides.forEach((s, k) => {
    const limit = k + 1 < slides.length ? slides[k + 1].start - 1 : stop;
    s.end = limit;
    for (let j = limit; j >= s.start; j--) if (lines[j - 1].includes('</section>')) { s.end = j; break; }
    const attr = n => (new RegExp(`\\b${n}="([^"]*)"`).exec(s.tag) || [])[1];
    s.id = attr('id'); s.title = attr('data-title'); s.layout = attr('data-layout');
  });
  const cur = sel?.slide ? slides.find(s => s.id === sel.slide.id) : null;
  const out = [`deck.html has ${lines.length} lines. Its slides (line ranges)${cur ? '; ▸ = the current slide' : ''}:`];
  slides.forEach((s, k) => out.push(`${s === cur ? '▸' : ' '} ${k + 1}. #${s.id || '?'}${s.title ? ` "${s.title}"` : ''}${s.layout ? ` [layout ${s.layout}]` : ''} lines ${s.start}–${s.end}`));
  const lb = lines.findIndex(l => l.includes('<template id="deck-layouts">'));
  if (lb >= 0) out.push(`(The template's layouts for + Slide: lines ${lb + 1}–${lines.findIndex((l, i) => i > lb && l.includes('</template>')) + 1}; not shown in the deck.)`);
  try {
    const js = fs.readFileSync(path.join(dir, 'animations.js'), 'utf8');
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // not the examples in comments
    const names = re => [...code.matchAll(re)].map(m => m[1]);
    const fx = names(/Deck\.effect\(\s*['"]([^'"]+)/g), sc = names(/Deck\.slide\(\s*['"]([^'"]+)/g);
    out.push(`animations.js has ${js.split('\n').length} lines; effects: ${fx.join(', ') || 'none'}; slide scripts: ${sc.join(', ') || 'none'}.`);
  } catch { /* no animations.js */ }
  // Where the selected objects are, so they can be read and edited directly.
  const where = new Map();
  if (cur && sel.elements) for (const e of sel.elements) {
    const key = (/data-el="([^"]+)"/.exec(e.html) || [])[1], id = (/^<[^>]*\bid="([^"]+)"/.exec(e.html) || [])[1];
    const needle = key ? `data-el="${key}"` : id ? `id="${id}"` : null;
    if (!needle) continue;
    for (let i = cur.start; i <= cur.end; i++) if (lines[i - 1].includes(needle)) { where.set(e, i); break; }
  }
  return { text: out.join('\n'), where };
}

function describe(sel, where) {
  if (!sel) return '';
  const out = [];
  if (sel.slide) out.push(`Current slide: #${sel.slide.index + 1} of ${sel.slide.count}, id="${sel.slide.id}"${sel.slide.title ? `, title "${sel.slide.title}"` : ''}${sel.slide.steps ? `, ${sel.slide.steps} click steps, viewing step ${sel.slide.step ?? 'final'}` : ''}.`);
  if (sel.elements && sel.elements.length) {
    out.push(`Selected object${sel.elements.length > 1 ? 's' : ''} on that slide (selector relative to the slide, box in stage px):`);
    sel.elements.forEach((e, i) => {
      out.push(`${i + 1}. \`${e.selector}\`${where.has(e) ? ` (deck.html line ${where.get(e)})` : ''} at x=${e.box.x} y=${e.box.y} w=${e.box.w} h=${e.box.h}\n\`\`\`html\n${e.html}\n\`\`\``);
    });
  } else if (sel.slide) out.push('No object is selected: the request is about the whole slide.');
  return out.join('\n');
}

// The prompt for one request. `told` is the audience this conversation was last told about: its full guidance is
// repeated only when the conversation is new or the audience changed. Returns { text, told }.
function buildPrompt(target, body, fresh, told) {
  const parts = [HEADER[target.kind](target.rel)];
  if (fresh) {
    let notes = '';
    try { notes = fs.readFileSync(sessionFile(target.dir), 'utf8').trim(); } catch { /* none */ }
    parts.push(`This is a new conversation about this ${target.kind}. Its session notes (${target.rel}/session.md), what earlier conversations learned:\n<session-notes>\n${notes || '(empty)'}\n</session-notes>`);
  }
  const deckHtml = fs.readFileSync(path.join(target.dir, 'deck.html'), 'utf8');
  const aud = readAudience(deckHtml), min = readDuration(deckHtml);
  const sig = aud || min ? JSON.stringify([aud, min]) : '';
  const length = min ? `Talk length: ${min} minutes (about ${slideCount(min, aud)} slides in all).` : '';
  if (sig && (fresh || sig !== told)) {
    parts.push(`<audience>\n${[aud && audienceGuide(aud), length].filter(Boolean).join('\n')}\nWrite and design every change for this audience${min ? ' and length' : ''} (unless the request says otherwise).\n</audience>`);
  } else if (sig) parts.push(`${aud ? `Audience: ${aud.key === 'custom' ? aud.text : audienceLabel(aud)}. ` : ''}${length} As described earlier in this conversation.`);
  const o = outline(target.dir, body.selection);
  parts.push(o.text, describe(body.selection, o.where), '', `Request: ${body.prompt}`);
  return { text: parts.join('\n'), told: sig };
}

/* ── Writing a whole deck from the user's material (the start page's Draft step) ── */

/**
 * The request that has Claude write the deck: from the files in its source/ folder and the pictures given, for its
 * talk length and audience, built from the template's layouts. Returns { prompt, shown } (shown: the short version
 * for the editor's log).
 */
export function draftPrompt(target, { images = [] } = {}) {
  const html = fs.readFileSync(path.join(target.dir, 'deck.html'), 'utf8');
  const aud = readAudience(html), min = readDuration(html) || 20, n = slideCount(min, aud);
  const src = path.join(target.dir, 'source');
  const files = fs.existsSync(src) ? fs.readdirSync(src).filter(f => !f.startsWith('.')).map(f => `${target.rel}/source/${f}`) : [];
  const attr = (s, a) => (new RegExp(`^<section\\b[^>]*\\b${a}="([^"]*)"`).exec(s) || [])[1] || '';
  const layouts = layoutsOf(html).map(l => `${attr(l, 'data-title') || attr(l, 'id')} (data-layout="${attr(l, 'data-layout')}")`);
  const material = [...files, ...images.map(i => `${target.rel}/${i}`)];
  const prompt = `Write this deck from the user's material: ${material.join(', ') || '(none)'}. Read all of it first (PDFs too).
It is a ${min}-minute talk${aud ? ` for ${aud.key === 'custom' ? 'the audience described below' : audienceLabel(aud)}` : ''}: plan about ${n} slides; fewer if the material is thin, never pad.
1. Plan the story first: a title slide, a motivation (why this matters) unless the audience or the material calls for something else, the main part in the material's own logic, and a clear end (takeaways or next steps, then a closing slide).
2. ${layouts.length
    ? `Build every slide from the template's layouts, which are in the <template id="deck-layouts"> block of deck.html (line numbers below): ${layouts.join('; ')}. For each slide copy the section of the layout that fits, give it a unique short id and a data-title, keep its data-layout and positions, and replace the placeholder text; delete placeholders you don't use. Your title slide replaces the deck's current first slide.`
    : 'The deck has no layouts: build the slides with the theme classes, absolutely positioned in stage px as CLAUDE.md says. Your title slide replaces the current first slide.'}
3. ${images.length ? `Use the user's pictures where they fit: put an <img src="…" style="…;object-fit:cover"> in an image placeholder's box (replacing it) or place it on the slide. ` : ''}Leave image placeholders you can't fill for the user.
4. Keep the on-slide text short and right for the audience; what the speaker says goes into each slide's speaker notes (<aside class="notes"><p>…</p></aside>), written to be spoken and sized to the time.
5. Add entrances and click steps where they help the story (data-anim, data-step).
6. In session.md, fill in About: the topic, the audience, the length and the main message.
Work in ${target.rel}/ only, and write deck.html in a few large edits (whole slides at a time). When done, reply with the slide titles in order.`;
  const shown = `Write the deck from your material (${min} min${aud ? `, ${aud.key === 'custom' ? 'your audience' : audienceLabel(aud)}` : ''}): ${material.map(m => path.basename(m)).join(', ')}`;
  return { prompt, shown };
}

/* ── The bridge ── */

export function createBridge({ broadcast, writeFile, fail, beforeRequest = () => {} }) {
  const agents = new Map(); // ref -> { proc, model, turn, … }: a running Claude
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { /* none yet */ }
  const remember = (ref, id) => {
    if ((saved[ref] || null) === (id || null)) return;
    if (id) saved[ref] = id; else delete saved[ref];
    try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(saved, null, 2) + '\n'); }
    catch (e) { console.warn('Could not save the Claude sessions:', e.message); }
  };

  function start(ref, model) {
    const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--tools', TOOLS, '--allowedTools', TOOLS,
      '--strict-mcp-config', // no MCP servers or connectors: faster start, smaller requests
      '--append-system-prompt', SYSTEM];
    if (saved[ref]) argv.push('--resume', saved[ref]);
    if (model) argv.push('--model', model);
    const a = { ref, model, turn: null, buf: '', err: '', idle: null, stopping: false };
    a.proc = spawn(CLAUDE, argv, { cwd: ROOT, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    a.closed = new Promise(resolve => a.proc.on('close', resolve));
    a.proc.stdout.on('data', c => onData(a, c));
    a.proc.stderr.on('data', c => { a.err = (a.err + c).slice(-8000); });
    a.proc.stdin.on('error', () => { /* it exited; 'close' reports why */ });
    a.proc.on('error', e => { a.err = e.code === 'ENOENT' ? `Claude Code CLI not found ("${CLAUDE}"). Install it or set DECK_CLAUDE_BIN.` : e.message; });
    a.proc.on('close', code => {
      clearTimeout(a.idle);
      if (agents.get(ref) === a) agents.delete(ref);
      if (a.turn) finish(a, a.stopping ? null : (a.err.trim() || `claude exited with code ${code}`));
    });
    agents.set(ref, a);
    return a;
  }

  function onData(a, chunk) {
    a.buf += chunk;
    let i;
    while ((i = a.buf.indexOf('\n')) >= 0) {
      const line = a.buf.slice(0, i).trim(); a.buf = a.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.session_id) remember(a.ref, m.session_id);
      const t = a.turn;
      if (!t) continue;
      if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c.type === 'text' && c.text.trim()) t.emit({ kind: 'text', text: c.text });
          if (c.type === 'tool_use') {
            const inp = c.input || {};
            const where = inp.file_path ? path.relative(ROOT, inp.file_path) + (inp.offset ? ` (lines ${inp.offset}–${inp.offset + (inp.limit || 0)})` : '') : inp.pattern || inp.path || '';
            t.emit({ kind: 'tool', name: c.name, detail: where });
          }
        }
      }
      if (m.type === 'result') { t.result = m; finish(a); }
    }
  }

  // Ends the current request of a Claude: reports, logs it in session.md, and keeps the process for the next one.
  function finish(a, error) {
    const t = a.turn;
    if (!t) return;
    a.turn = null;
    if (t.result) {
      const m = t.result;
      t.emit({ kind: 'done', ok: !m.is_error, result: m.result, cost: m.total_cost_usd, ms: m.duration_ms });
      try { logRequest(t.dir, t.kind, t.request, m.is_error ? `(error) ${m.result || ''}` : m.result); } catch (e) { console.warn('session.md:', e.message); }
    } else if (error && /no conversation found/i.test(error) && !t.retried) {
      // The saved conversation is gone (its transcript was deleted): start a new one from the session notes.
      remember(a.ref, null);
      t.retried = true;
      t.emit({ kind: 'info', message: 'The earlier conversation could not be resumed; starting a new one from the deck’s session notes.' });
      dispatch(a.ref, t);
      return;
    } else t.emit(error ? { kind: 'error', message: error } : { kind: 'stopped', message: 'Stopped.' });
    t.end();
    broadcast({ type: 'claude', deck: a.ref, running: false });
    if (agents.get(a.ref) === a) a.idle = setTimeout(() => quit(a), IDLE_MS);
  }

  function logRequest(dir, kind, request, result) {
    const file = ensureSessionNotes(dir, kind);
    let text = fs.readFileSync(file, 'utf8');
    if (!/^## Log[ \t]*$/m.test(text)) text = text.trimEnd() + '\n\n## Log\n';
    const at = text.search(/^## Log[ \t]*$/m);
    const entries = text.slice(at).split('\n').filter(l => l.startsWith('- '));
    entries.push(`- ${stamp()} · ${oneLine(request, 160)} → ${oneLine(result, 240)}`);
    writeFile(file, `${text.slice(0, at)}## Log\n\n${entries.slice(-30).join('\n')}\n`);
  }

  // Stops a Claude that is idle (closing its input lets it finish cleanly).
  async function quit(a) {
    clearTimeout(a.idle);
    if (agents.get(a.ref) === a) agents.delete(a.ref);
    try { a.proc.stdin.end(); } catch { /* gone */ }
    const kill = setTimeout(() => a.proc.kill('SIGTERM'), 4000);
    await a.closed;
    clearTimeout(kill);
  }

  async function dispatch(ref, t) {
    let a = agents.get(ref);
    if (a && a.model !== t.model) { await quit(a); a = null; } // another model: same conversation, new process
    const fresh = !saved[ref];
    const warm = !!a;
    if (!a) a = start(ref, t.model);
    clearTimeout(a.idle);
    a.turn = t;
    t.emit({ kind: 'start', resumed: !fresh, warm });
    let text;
    try { ({ text, told: a.told } = t.build(fresh, a.told)); }
    catch (e) { a.turn = null; t.emit({ kind: 'error', message: e.message }); t.end(); broadcast({ type: 'claude', deck: ref, running: false }); return; }
    a.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null }) + '\n');
  }

  const isRunning = ref => !!agents.get(ref)?.turn;

  /** POST /api/claude: streams the request's progress as NDJSON. */
  function run(res, body) {
    const ref = body.deck;
    let target;
    try { target = resolveRef(ref); } catch { return fail(res, 400, 'Unknown deck'); }
    if (!fs.existsSync(path.join(target.dir, 'deck.html'))) return fail(res, 400, 'Unknown deck');
    if (isRunning(ref)) return fail(res, 409, 'Claude is already working on this deck');
    ensureSessionNotes(target.dir, target.kind);
    try { beforeRequest(target, body); } catch (e) { console.warn('Could not save a version before the request:', e.message); }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const t = {
      dir: target.dir, kind: target.kind, request: body.prompt, model: body.model || MODEL,
      emit: o => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); },
      end: () => { if (!res.writableEnded) res.end(); },
      build: (fresh, told) => buildPrompt(target, body, fresh, told),
    };
    res.on('close', () => { if (!res.writableFinished) stop(ref); }); // the editor went away mid-request
    broadcast({ type: 'claude', deck: ref, running: true });
    dispatch(ref, t);
  }

  /** Stop: ends the current request (the conversation is kept for the next one). */
  function stop(ref) {
    const a = agents.get(ref);
    if (!a?.turn) return false;
    a.stopping = true;
    a.proc.kill('SIGTERM');
    return true;
  }

  /** New chat, or the deck is gone: the next request starts a new conversation (session.md stays). */
  async function forget(ref) {
    const a = agents.get(ref);
    if (a) { if (a.turn) { stop(ref); await a.closed; } else await quit(a); }
    remember(ref, null);
  }

  /** On shutdown: stop every Claude. */
  const stopAll = () => { for (const a of agents.values()) a.proc.kill('SIGTERM'); };

  return { run, stop, forget, isRunning, stopAll };
}
