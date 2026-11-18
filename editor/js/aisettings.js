// AI settings: choose the provider (Claude Code, Anthropic API, Ollama, LM Studio, OpenAI-compatible), sign in or
// enter keys, pick a model. Keys are stored by the dev server outside the repository and never sent back here.
import { $, $$, api, toast } from './app.js';

let conf = null;        // public config from the server
let shown = null;       // provider shown in the dialog
let poll = null;        // sign-in polling timer
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const INFO = {
  'claude-code': {
    sub: 'Agent · edits the files itself',
    lead: 'Runs Claude Code on this computer. It reads and edits the deck like in your terminal and follows CLAUDE.md. Best results, and it can write new effects and several slides at once.',
  },
  anthropic: {
    sub: 'Claude through the API',
    lead: 'Calls Claude directly through the Anthropic API with your API key. Billed to your Anthropic Console account.',
    key: { label: 'API key', placeholder: 'sk-ant-…', link: ['Get an API key', 'https://console.anthropic.com/settings/keys'] },
    note: 'Without a key here, <code>ANTHROPIC_API_KEY</code> or an <code>ant auth login</code> profile is used if present.',
    advancedUrl: true,
  },
  ollama: {
    sub: 'Local models · native API',
    lead: 'Uses a model running in Ollama on this computer or your network. Nothing leaves your machine.',
    key: { label: 'API key', placeholder: 'only for a remote or cloud server', optional: true },
    note: 'Install a model with <code>ollama pull qwen3</code> (or any other). Larger models follow the edit format more reliably. The context length is sent with every request; raise it for big decks if your memory allows.',
    url: 'http://localhost:11434', ctx: true,
  },
  lmstudio: {
    sub: 'Local models · OpenAI format',
    lead: 'Uses the model loaded in LM Studio. Start the server in LM Studio’s Developer tab and load a model.',
    key: { label: 'API token', placeholder: 'needed when “Require API token” is on', optional: true },
    note: 'If LM Studio requires an API token, create one in LM Studio (Developer → Server settings) and paste it here. Set the context length when loading the model; 16k or more works well.',
    url: 'http://localhost:1234/v1',
  },
  openai: {
    sub: 'OpenAI, OpenRouter, Groq, vLLM …',
    lead: 'Any server that speaks the OpenAI chat-completions format.',
    key: { label: 'API key', placeholder: 'sk-…', optional: true },
    note: 'Base URLs: OpenAI <code>https://api.openai.com/v1</code> · OpenRouter <code>https://openrouter.ai/api/v1</code> · Groq <code>https://api.groq.com/openai/v1</code> · llama.cpp / vLLM <code>http://localhost:8000/v1</code>. Without a key here, <code>OPENAI_API_KEY</code> is used if set.',
    url: '',
  },
};

export const activeLabel = () => (conf ? conf.providers[conf.active].label : 'AI');

export async function initAI() {
  conf = await api.get('/api/ai');
  $('#ai-provider').onclick = () => openDialog();
  $('#ai-dialog').addEventListener('click', e => { if (e.target.id === 'ai-dialog' || e.target.closest('[data-ai-close]')) closeDialog(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#ai-dialog').hidden) closeDialog(); });
  $('#claude-model').onchange = async e => { conf = await api.put('/api/ai', { provider: conf.active, settings: { model: e.target.value } }); };
  await refreshBar();
}

// The prompt bar: provider chip and the model list of the active provider.
async function refreshBar() {
  const p = conf.providers[conf.active];
  const chip = $('#ai-provider');
  chip.textContent = p.label;
  chip.classList.remove('warn');
  const sel = $('#claude-model');
  const fill = (models, note) => {
    const list = [...new Set([p.model, ...models].filter(m => m !== undefined))];
    sel.innerHTML = list.map(m => `<option value="${esc(m)}" ${m === p.model ? 'selected' : ''}>${m === '' ? 'Default model' : esc(m)}</option>`).join('')
      + (note ? `<option disabled>${esc(note)}</option>` : '');
    if (!list.length) sel.innerHTML = '<option value="">Choose a model in settings</option>';
  };
  fill([], null);
  const r = await api.get(`/api/ai/models?provider=${conf.active}`).catch(e => ({ ok: false, error: e.message }));
  if (r.ok) fill(r.models.filter(m => conf.active !== 'claude-code' || m !== ''), null);
  else { fill([], 'not reachable'); chip.classList.add('warn'); chip.title = `${p.label}: ${r.error}`; }
  if (r.ok) chip.title = `${p.label}: click for AI settings`;
}

function openDialog(id) {
  shown = id || conf.active;
  $('#ai-dialog').hidden = false;
  render();
}
function closeDialog() { $('#ai-dialog').hidden = true; clearInterval(poll); refreshBar(); }

function render() {
  $('#ai-list').innerHTML = Object.entries(conf.providers).map(([id, p]) =>
    `<button type="button" data-p="${id}" class="${id === shown ? 'on' : ''}"><span>${esc(p.label)}</span><small>${INFO[id].sub}</small>${id === conf.active ? '<span class="act">● in use</span>' : ''}</button>`).join('');
  $$('#ai-list [data-p]').forEach(b => b.onclick = () => { clearInterval(poll); shown = b.dataset.p; render(); });
  const p = conf.providers[shown], info = INFO[shown];
  const pane = $('#ai-pane');
  if (shown === 'claude-code') {
    pane.innerHTML = `<h4>${p.label}</h4><p class="lead">${info.lead}</p><div id="cc-status" class="status">Checking…</div><div class="btns" id="cc-actions"></div>`;
    claudeStatus();
  } else {
    pane.innerHTML = `<h4>${p.label}</h4><p class="lead">${info.lead}</p>
      ${'url' in info || info.advancedUrl ? `<div class="row"><label>${info.advancedUrl ? 'Base URL' : 'Server URL'}</label><input data-f="baseUrl" value="${esc(p.baseUrl)}" placeholder="${esc(info.url || 'default: https://api.anthropic.com')}"></div>` : ''}
      ${info.key ? `<div class="row"><label>${info.key.label}</label><input data-f="apiKey" type="password" autocomplete="off" placeholder="${p.hasKey ? 'saved ' + esc(p.keyHint) + ' (type to replace)' : p.envKey ? 'using the environment variable' : esc(info.key.placeholder)}">
        ${p.hasKey ? '<button type="button" id="key-remove" title="Remove the saved key">Remove</button>' : ''}</div>
        ${info.key.link ? `<p class="hint" style="margin-left:116px"><a href="${info.key.link[1]}" target="_blank" rel="noopener">${info.key.link[0]} ↗</a></p>` : ''}` : ''}
      ${info.ctx ? `<div class="row"><label>Context length</label><input data-f="numCtx" type="number" min="2048" step="1024" value="${esc(p.numCtx)}"></div>` : ''}
      <div class="row"><label>Model</label><select data-f="model" id="model-pick"><option value="${esc(p.model)}">${esc(p.model || 'Choose after testing the connection')}</option></select></div>
      <div id="conn" class="status">Not tested yet.</div>
      <p class="hint">${info.note || ''}</p>`;
    $$('#ai-pane [data-f]').forEach(inp => inp.addEventListener('change', async () => {
      if (inp.dataset.f === 'apiKey' && !inp.value) return;
      conf = await api.put('/api/ai', { provider: shown, settings: { [inp.dataset.f]: inp.value } });
      if (inp.dataset.f === 'apiKey') { toast('Key saved on this computer (not in the repository).', 2500); render(); return; }
      if (inp.dataset.f !== 'model') test();
    }));
    const rm = $('#key-remove');
    if (rm) rm.onclick = async () => { conf = await api.put('/api/ai', { provider: shown, settings: { apiKey: '' } }); render(); };
    test();
  }
  $('#ai-foot').innerHTML = `<span class="grow">Settings are stored in <code>${esc(conf.file)}</code></span>
    ${shown === conf.active ? '<button type="button" data-ai-close>Done</button>' : `<button type="button" data-ai-close>Close</button><button type="button" class="primary" id="ai-use">Use ${esc(p.label)}</button>`}`;
  const use = $('#ai-use');
  if (use) use.onclick = async () => { conf = await api.put('/api/ai', { active: shown }); toast(`Now using ${p.label}.`, 2000); closeDialog(); };
}

async function test() {
  const box = $('#conn'), id = shown;
  if (!box) return;
  box.className = 'status wait'; box.textContent = 'Connecting…';
  const r = await api.get(`/api/ai/models?provider=${id}`).catch(e => ({ ok: false, error: e.message }));
  if (shown !== id || !$('#conn')) return;
  const pick = $('#model-pick'), p = conf.providers[id];
  if (r.ok) {
    box.className = 'status ok';
    box.textContent = r.models.length ? `Connected · ${r.models.length} model${r.models.length === 1 ? '' : 's'} available.` : 'Connected, but no models are available. Load or download one first.';
    pick.innerHTML = (p.model && !r.models.includes(p.model) ? [p.model] : []).concat(r.models)
      .map(m => `<option ${m === p.model ? 'selected' : ''}>${esc(m)}</option>`).join('') || '<option value="">No models</option>';
    if (!p.model && r.models[0]) { pick.value = r.models[0]; conf = await api.put('/api/ai', { provider: id, settings: { model: r.models[0] } }); }
  } else {
    box.className = 'status bad';
    box.textContent = `Not connected: ${r.error}`;
  }
}

async function claudeStatus() {
  const st = await api.get('/api/ai/claude-status');
  const box = $('#cc-status'), act = $('#cc-actions');
  if (!box || shown !== 'claude-code') return st;
  if (!st.installed) {
    box.className = 'status bad';
    box.innerHTML = 'Claude Code is not installed. <a href="https://claude.com/claude-code" target="_blank" rel="noopener">Install it ↗</a>, then come back here to sign in.';
    act.innerHTML = '';
    return st;
  }
  if (st.loggedIn) {
    box.className = 'status ok';
    box.innerHTML = `Signed in${st.email ? ` as <b>${esc(st.email)}</b>` : ''}${st.method ? ` · ${esc(st.method === 'claude.ai' ? 'Claude account' : st.method)}` : ''}${st.subscription ? ` (${esc(st.subscription)})` : ''}.<br><span class="hint">Claude Code ${esc(st.version)}</span>`;
    act.innerHTML = '<button type="button" id="cc-logout">Sign out</button>';
    $('#cc-logout').onclick = async () => {
      if (!confirm('Sign out of Claude Code on this computer? This also signs out the terminal.')) return;
      await api.post('/api/ai/claude-logout');
      claudeStatus();
    };
  } else {
    box.className = 'status ' + (st.signingIn ? 'wait' : 'bad');
    box.innerHTML = st.signingIn ? 'Waiting for you to finish signing in in your browser…' : `Not signed in.<br><span class="hint">Claude Code ${esc(st.version)}</span>`;
    act.innerHTML = `<button type="button" class="primary" data-login="claudeai">Sign in with your Claude account</button>
      <button type="button" data-login="console">Sign in with Anthropic Console (API billing)</button>`;
    $$('#cc-actions [data-login]').forEach(b => b.onclick = () => login(b.dataset.login));
  }
  return st;
}

async function login(method) {
  const box = $('#cc-status');
  box.className = 'status wait';
  box.textContent = 'Opening the sign-in page…';
  const r = await api.post(`/api/ai/claude-login?method=${method}`);
  box.innerHTML = 'Finish signing in in your browser. This updates by itself.'
    + (r.url ? `<br>If no page opened: <a href="${esc(r.url)}" target="_blank" rel="noopener">open the sign-in page ↗</a>` : '');
  clearInterval(poll);
  const until = Date.now() + 5 * 60 * 1000;
  poll = setInterval(async () => {
    const st = await claudeStatus();
    if (st.loggedIn || Date.now() > until) { clearInterval(poll); if (st.loggedIn) toast('Signed in to Claude Code.', 2500); }
  }, 2000);
}
