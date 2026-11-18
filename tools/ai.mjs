// AI providers for the editor's prompt bar.
//
//   claude-code  Claude Code CLI: an agent that edits the deck files itself (best results). Login via `claude auth`.
//   anthropic    Anthropic API (Messages API, official SDK). API key, ANTHROPIC_API_KEY, or an `ant auth login` profile.
//   ollama       Ollama native API (/api/chat), so the context length can be raised. Optional key for remote servers.
//   lmstudio     LM Studio, OpenAI-compatible API (/v1/chat/completions). Optional API token.
//   openai       Any OpenAI-compatible server: OpenAI, OpenRouter, Groq, vLLM, llama.cpp …
//
// Chat providers cannot edit files, so they answer in a block format (see EDIT_FORMAT) that this module validates
// and applies to deck.html / animations.js. Settings live outside the repository (keys never end up in git) and keys
// are never sent back to the browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './lib.mjs';

/* ── Settings ─────────────────────────────────────────────────────────────── */

export const CONFIG_FILE = process.env.DECKELSMOUK_CONFIG || path.join(os.homedir(), '.config', 'deckelsmouk', 'config.json');

export const PROVIDERS = {
  'claude-code': { label: 'Claude Code', kind: 'agent', defaults: { model: '' } },
  anthropic: { label: 'Anthropic API', kind: 'anthropic', defaults: { model: 'claude-opus-5-5', apiKey: '', baseUrl: '' } },
  ollama: { label: 'Ollama', kind: 'ollama', defaults: { baseUrl: 'http://localhost:11434', model: '', apiKey: '', numCtx: 16384 } },
  lmstudio: { label: 'LM Studio', kind: 'openai', defaults: { baseUrl: 'http://localhost:1234/v1', model: '', apiKey: '' } },
  openai: { label: 'OpenAI-compatible', kind: 'openai', defaults: { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' } },
};

export function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  const providers = {};
  for (const [id, p] of Object.entries(PROVIDERS)) providers[id] = { ...p.defaults, ...((saved.providers || {})[id] || {}) };
  const active = PROVIDERS[saved.active] ? saved.active : 'claude-code';
  return { active, providers };
}

export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort on other systems */ }
}

// What the browser may see: everything except secrets.
export function publicConfig(cfg = loadConfig()) {
  const providers = {};
  for (const [id, s] of Object.entries(cfg.providers)) {
    const { apiKey, ...rest } = s;
    const envKey = id === 'anthropic' ? process.env.ANTHROPIC_API_KEY : id === 'openai' ? process.env.OPENAI_API_KEY : '';
    providers[id] = { ...rest, label: PROVIDERS[id].label, kind: PROVIDERS[id].kind,
      hasKey: !!apiKey, keyHint: apiKey ? '••••' + (apiKey.length >= 12 ? apiKey.slice(-4) : '') : '', envKey: !apiKey && !!envKey };
  }
  return { active: cfg.active, providers, file: CONFIG_FILE };
}

// Applies a settings change from the browser. apiKey: undefined keeps the saved key, '' removes it.
export function updateConfig(change) {
  const cfg = loadConfig();
  if (change.active && PROVIDERS[change.active]) cfg.active = change.active;
  if (change.provider && PROVIDERS[change.provider] && change.settings) {
    const cur = cfg.providers[change.provider];
    for (const [k, v] of Object.entries(change.settings)) {
      if (!(k in PROVIDERS[change.provider].defaults)) continue;
      if (k === 'apiKey' && v === undefined) continue;
      cur[k] = k === 'numCtx' ? Math.max(2048, +v || 16384) : typeof v === 'string' ? v.trim() : v;
    }
    if (cur.baseUrl) cur.baseUrl = cur.baseUrl.replace(/\/+$/, '');
  }
  saveConfig(cfg);
  return publicConfig(cfg);
}

const keyOf = (id, s) => s.apiKey || (id === 'openai' ? process.env.OPENAI_API_KEY || '' : '');
const bearer = key => (key ? { Authorization: `Bearer ${key}` } : {});

async function anthropicClient(s) {
  let mod;
  try { mod = await import('@anthropic-ai/sdk'); }
  catch { throw new Error('The Anthropic SDK is not installed. Run `npm install` in the Deckelsmouk folder.'); }
  const Anthropic = mod.default;
  const opts = {};
  if (s.apiKey) opts.apiKey = s.apiKey; // otherwise the SDK finds ANTHROPIC_API_KEY or an `ant auth login` profile
  if (s.baseUrl) opts.baseURL = s.baseUrl;
  return new Anthropic(opts);
}

async function getJSON(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (!r.ok) throw new Error((body && (body.error?.message || body.error)) || `${r.status} ${r.statusText}`);
  return body;
}

/** Models offered by a provider (also serves as the connection test). */
export async function listModels(id, cfg = loadConfig()) {
  const s = cfg.providers[id];
  if (id === 'claude-code') return ['', 'opus', 'sonnet', 'haiku', 'fable'];
  if (id === 'anthropic') {
    const client = await anthropicClient(s);
    const ids = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  }
  if (id === 'ollama') return ((await getJSON(`${s.baseUrl}/api/tags`, bearer(s.apiKey))).models || []).map(m => m.name);
  return ((await getJSON(`${s.baseUrl}/models`, bearer(keyOf(id, s)))).data || []).map(m => m.id);
}

/* ── Prompt ───────────────────────────────────────────────────────────────── */

export const EDIT_FORMAT = `Answer ONLY with edit blocks in exactly this format, followed by a MESSAGE block:

<<<REPLACE_SLIDE id="slide-id">>>
<section class="slide" id="slide-id" data-title="…">
  … the complete new HTML of that slide …
</section>
<<<END>>>

Other blocks, only when the request needs them:
<<<ADD_SLIDE after="slide-id">>> <section class="slide" id="new-unique-id" data-title="…">…</section> <<<END>>>
<<<DELETE_SLIDE id="slide-id">>><<<END>>>
<<<APPEND_CSS>>> new CSS rules for the deck's theme (<style id="deck-style">) <<<END>>>
<<<APPEND_JS>>> new code for animations.js: Deck.effect(…) / Deck.slide(…) <<<END>>>
<<<MESSAGE>>> One or two sentences saying what you changed. <<<END>>>

Rules for blocks: always give the COMPLETE <section> of a slide you change, never a fragment or a diff. Keep everything
you were not asked to change exactly as it was (ids, data-el, classes, text, the <aside class="notes">). Put no
markdown fences inside blocks. Write nothing outside the blocks.`;

function guide() {
  // The deck format reference, without the parts that only concern Claude Code's file access.
  let md = '';
  try { md = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'); } catch { /* repository without it */ }
  return md.split(/\n(?=## )/).filter(s => /^## (deck\.html rules|Animation|animations\.js)/.test(s)).join('\n');
}

export function systemPrompt() {
  return `You are the design assistant inside Deckelsmouk, a visual editor for animated HTML presentations.
The user selects a slide or objects on it and asks for a change: arranging, restyling, animating, writing.
You change the deck by answering with edit blocks that the editor applies.

${guide()}

${EDIT_FORMAT}`;
}

const sliceSlide = (html, id) => {
  const open = new RegExp(`<section\\b[^>]*\\bid=["']${escapeRe(id)}["'][^>]*>`).exec(html);
  if (!open) return null;
  const end = html.indexOf('</section>', open.index);
  return end < 0 ? null : { start: open.index, end: end + '</section>'.length, html: html.slice(open.index, end + '</section>'.length) };
};
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The user turn: theme, slide list, the current slide in full, animations.js, the selection and the request. */
export function userPrompt({ html, js, selection, request, describe }) {
  const theme = (/<style id="deck-style">([\s\S]*?)<\/style>/.exec(html) || [])[1] || '';
  const list = [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((m, i) => {
    const t = (/data-title="([^"]*)"/.exec(m[0]) || [])[1] || '';
    return `${i + 1}. ${m[1]}${t ? ` "${t}"` : ''}${selection?.slide?.id === m[1] ? '   ← current' : ''}`;
  }).join('\n');
  const cur = selection?.slide ? sliceSlide(html, selection.slide.id) : null;
  let anim = js.trim();
  if (anim.length > 9000) { // keep the request small for local models: effect names plus this slide's script
    const names = [...anim.matchAll(/Deck\.effect\(\s*['"]([^'"]+)/g)].map(m => m[1]);
    const own = selection?.slide ? (new RegExp(`Deck\\.slide\\(\\s*['"]${escapeRe(selection.slide.id)}['"][\\s\\S]*?\\n\\}\\);`).exec(anim) || [''])[0] : '';
    anim = `// (shortened) custom effects defined: ${names.join(', ') || 'none'}\n${own}`;
  }
  return [
    `Theme (<style id="deck-style">):\n\`\`\`css\n${theme.trim()}\n\`\`\``,
    `Slides:\n${list}`,
    cur ? `Current slide, complete HTML:\n\`\`\`html\n${cur.html}\n\`\`\`` : '',
    `animations.js:\n\`\`\`js\n${anim || '// empty'}\n\`\`\``,
    describe(selection),
    `Request: ${request}`,
  ].filter(Boolean).join('\n\n');
}

/* ── Streaming chat ───────────────────────────────────────────────────────── */

async function* lines(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) yield buf;
}

async function post(url, headers, body, signal) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!r.ok) {
    const text = await r.text();
    let msg = text; try { const j = JSON.parse(text); msg = j.error?.message || j.error || text; } catch { /* plain text */ }
    throw new Error(`${r.status}: ${String(msg).slice(0, 300)}`);
  }
  return r;
}

/**
 * Streams a chat completion. Calls onText(delta) as text arrives and resolves with the full text.
 * messages: [{role: 'user'|'assistant', content}]; system is passed separately.
 */
export async function chat(id, { system, messages, model, signal, onText }, cfg = loadConfig()) {
  const s = cfg.providers[id];
  const use = model || s.model;
  if (!use) throw new Error(`Choose a model for ${PROVIDERS[id].label} in the AI settings.`);
  let full = '';
  const add = t => { if (t) { full += t; onText(t); } };

  if (id === 'anthropic') {
    const client = await anthropicClient(s);
    const params = { model: use, max_tokens: 64000, system, messages };
    // Current models: medium effort suits slide edits; the server-side fallback answers if a request is declined.
    if (/^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(use)) params.output_config = { effort: 'medium' };
    if (/^claude-(opus-5|sonnet-5-5|fable-5-[12]|mythos-5-[12])/.test(use)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    const stream = (params.betas ? client.beta.messages : client.messages).stream(params);
    const abort = () => stream.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      for await (const ev of stream) if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') add(ev.delta.text);
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new Error('The model declined this request.');
      if (final.stop_reason === 'max_tokens') throw new Error('The answer was cut off (too long). Try a smaller request.');
    } finally { signal.removeEventListener('abort', abort); }
    return full;
  }

  if (id === 'ollama') {
    const r = await post(`${s.baseUrl}/api/chat`, bearer(s.apiKey), {
      model: use, stream: true, messages: [{ role: 'system', content: system }, ...messages],
      options: { num_ctx: +s.numCtx || 16384, temperature: 0.2 },
    }, signal);
    for await (const line of lines(r.body)) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.error) throw new Error(m.error);
      add(m.message?.content);
      if (m.done) break;
    }
    return full;
  }

  // OpenAI-compatible (LM Studio, OpenAI, OpenRouter, vLLM, llama.cpp …)
  const r = await post(`${s.baseUrl}/chat/completions`, bearer(keyOf(id, s)), {
    model: use, stream: true, temperature: 0.2, messages: [{ role: 'system', content: system }, ...messages],
  }, signal);
  for await (const line of lines(r.body)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    const m = JSON.parse(data);
    if (m.error) throw new Error(m.error.message || String(m.error));
    add(m.choices?.[0]?.delta?.content);
  }
  return full;
}

/* ── Applying the answer ──────────────────────────────────────────────────── */

export function parseBlocks(text) {
  const blocks = [];
  const re = /<<<\s*([A-Z_]+)([^>]*)>>>([\s\S]*?)<<<\s*END\s*>>>/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = Object.fromEntries([...m[2].matchAll(/(\w+)\s*=\s*["']([^"']*)["']/g)].map(a => [a[1], a[2]]));
    const body = m[3].trim().replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim();
    blocks.push({ type: m[1], attrs, body });
  }
  return blocks;
}

function checkSection(body) {
  const s = body.trim();
  if (!/^<section\b[^>]*class=["'][^"']*\bslide\b/.test(s)) return 'it does not start with <section class="slide">';
  if (!s.endsWith('</section>')) return 'it does not end with </section>';
  if ((s.match(/<section\b/g) || []).length !== 1) return 'it contains more than one <section>';
  return null;
}

/**
 * Applies edit blocks to the deck files. Returns { html, js, done: [lines], skipped: [lines], message }.
 * Invalid blocks are skipped with a reason; the rest still apply.
 */
export function applyBlocks(blocks, html, js) {
  const done = [], skipped = [];
  let message = '';
  const ids = () => new Set([...html.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)].map(m => m[1]));
  for (const b of blocks) {
    if (b.type === 'MESSAGE') { message = b.body; continue; }
    if (b.type === 'REPLACE_SLIDE' || b.type === 'ADD_SLIDE') {
      const bad = checkSection(b.body);
      if (bad) { skipped.push(`${b.type} ${b.attrs.id || b.attrs.after || ''}: ${bad}`); continue; }
      let sec = b.body.trim();
      if (b.type === 'REPLACE_SLIDE') {
        const id = b.attrs.id || (/\bid="([^"]+)"/.exec(sec) || [])[1];
        const old = id && sliceSlide(html, id);
        if (!old) { skipped.push(`REPLACE_SLIDE ${id}: no such slide`); continue; }
        if (!/\bid="/.test(/<section\b[^>]*>/.exec(sec)[0])) sec = sec.replace('<section', `<section id="${id}"`);
        // Notes the model left out are kept.
        const notes = /<aside\b[^>]*class=["'][^"']*\bnotes\b[\s\S]*?<\/aside>/.exec(old.html);
        if (notes && !/class=["'][^"']*\bnotes\b/.test(sec)) sec = sec.replace(/\s*<\/section>$/, `\n  ${notes[0]}\n</section>`);
        html = html.slice(0, old.start) + sec + html.slice(old.end);
        done.push(`Replaced slide ${id}`);
      } else {
        const after = b.attrs.after && sliceSlide(html, b.attrs.after);
        let id = (/\bid="([^"]+)"/.exec(/<section\b[^>]*>/.exec(sec)[0]) || [])[1] || 'slide';
        const taken = ids();
        if (taken.has(id) || !/\bid="/.test(/<section\b[^>]*>/.exec(sec)[0])) {
          let n = 2, base = id; while (taken.has(`${base}-${n}`)) n++; const nid = taken.has(id) ? `${base}-${n}` : id;
          sec = /\bid="/.test(/<section\b[^>]*>/.exec(sec)[0]) ? sec.replace(/(<section\b[^>]*\bid=")[^"]+"/, `$1${nid}"`) : sec.replace('<section', `<section id="${nid}"`);
          id = nid;
        }
        const insertAt = after ? after.end : html.indexOf('<!-- ==================== END SLIDES');
        if (insertAt < 0) { skipped.push(`ADD_SLIDE ${id}: no place to insert`); continue; }
        html = html.slice(0, insertAt) + `\n\n<!-- ===== Slide · ${id} ===== -->\n${sec}\n` + html.slice(insertAt);
        done.push(`Added slide ${id}`);
      }
      continue;
    }
    if (b.type === 'DELETE_SLIDE') {
      const old = sliceSlide(html, b.attrs.id || '');
      if (!old) { skipped.push(`DELETE_SLIDE ${b.attrs.id}: no such slide`); continue; }
      if (ids().size <= 1) { skipped.push('DELETE_SLIDE: the last slide stays'); continue; }
      const marker = html.lastIndexOf('<!-- ===== Slide', old.start);
      const from = marker >= 0 && !html.slice(marker, old.start).includes('</section>') ? marker : old.start;
      html = html.slice(0, from) + html.slice(old.end).replace(/^\s*\n/, '\n');
      done.push(`Deleted slide ${b.attrs.id}`);
      continue;
    }
    if (b.type === 'APPEND_CSS') {
      const at = html.search(/<\/style>/);
      const open = html.indexOf('<style id="deck-style">');
      const close = open >= 0 ? html.indexOf('</style>', open) : at;
      if (close < 0 || /<\/?(style|script)/i.test(b.body)) { skipped.push('APPEND_CSS: no theme stylesheet or invalid CSS'); continue; }
      html = html.slice(0, close) + `\n  ${b.body.replace(/\n/g, '\n  ')}\n` + html.slice(close);
      done.push('Added theme CSS');
      continue;
    }
    if (b.type === 'APPEND_JS') {
      const next = js.replace(/\s*$/, '\n\n') + b.body + '\n';
      try { new vm.Script(next, { filename: 'animations.js' }); }
      catch (e) { skipped.push(`APPEND_JS: ${e.message} (not added)`); continue; }
      js = next;
      done.push('Added code to animations.js');
      continue;
    }
    skipped.push(`Unknown block ${b.type}`);
  }
  return { html, js, done, skipped, message };
}
