// Drives a browser that is already installed, in the background, to print PDFs and take screenshots for the exports.
// Chrome, Chromium, Edge or Brave through the DevTools protocol, or Firefox through WebDriver BiDi. No dependencies
// (Node 22's WebSocket). DECK_BROWSER=/path/to/browser picks one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const PF = env.ProgramFiles || 'C:\\Program Files', PF86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', LOCAL = env.LOCALAPPDATA || '';
const CANDIDATES = process.platform === 'darwin' ? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
] : process.platform === 'win32' ? [
  `${PF}\\Google\\Chrome\\Application\\chrome.exe`, `${PF86}\\Google\\Chrome\\Application\\chrome.exe`, `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`,
  `${PF86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${PF}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${PF}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${PF}\\Mozilla Firefox\\firefox.exe`, `${PF86}\\Mozilla Firefox\\firefox.exe`,
] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser', 'firefox', 'firefox-esr'];

function which(bin) {
  if (bin.includes('/') || bin.includes('\\')) return fs.existsSync(bin) ? bin : null;
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, bin);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

/** The browser to use: { bin, kind: 'chromium' | 'firefox' } or null. */
export function findBrowser() {
  for (const c of env.DECK_BROWSER ? [env.DECK_BROWSER] : CANDIDATES) {
    const bin = which(c);
    if (bin) return { bin, kind: /firefox/i.test(path.basename(bin)) ? 'firefox' : 'chromium' };
  }
  return null;
}

// A JSON-over-WebSocket protocol client: send(method, params, extra) → result; events through on(method, fn).
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map(), listeners = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error || m.type === 'error') p.no(new Error(typeof m.error === 'string' ? `${m.error}: ${m.message}` : m.error?.message || 'browser error'));
        else p.ok(m.result);
      } else if (m.method) listeners.forEach(l => l(m));
    };
    ws.onerror = () => reject(new Error('could not talk to the browser'));
    ws.onopen = () => resolve({
      send: (method, params = {}, extra = {}) => new Promise((ok, no) => { const i = ++id; pending.set(i, { ok, no }); ws.send(JSON.stringify({ id: i, method, params, ...extra })); }),
      on: fn => listeners.push(fn),
      close: () => ws.close(),
    });
  });
}

function launch(bin, args, pattern) {
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${path.basename(bin)} did not start in time`)); }, 40000);
    const onData = d => {
      out += d;
      const m = pattern.exec(out);
      if (m) { clearTimeout(timer); resolve({ proc, url: m[1] }); }
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`${path.basename(bin)} quit (${code}): ${out.trim().split('\n').slice(-3).join(' ')}`)); });
  });
}

/**
 * Opens the browser with a page of the given size. Returns
 * { kind, goto(url), json(expr) → value of a JSON-serialisable expression, shot({ x, y, w, h }, jpeg?) → Buffer,
 *   pdf() → Buffer (CSS page size, backgrounds on), close() }.
 */
export async function openBrowser({ width = 1920, height = 1080, scale = 1 } = {}) {
  const found = findBrowser();
  if (!found) throw new Error('PDF and PowerPoint export use a browser in the background, and none was found. Install Chrome, Chromium, Edge or Firefox (or set DECK_BROWSER to one).');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deckelsmouk-render-'));
  const cleanup = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still in use */ } };
  try { return await (found.kind === 'firefox' ? firefox : chromium)(found.bin, profile, { width, height, scale }, cleanup); }
  catch (e) { cleanup(); throw e; }
}

async function chromium(bin, profile, { width, height, scale }, cleanup) {
  const { proc, url } = await launch(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--allow-file-access-from-files', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], /DevTools listening on (ws:\/\/\S+)/);
  const c = await connect(url);
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => c.send(method, params, { sessionId });
  let loaded = null;
  c.on(m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired' && loaded) { loaded(); loaded = null; } });
  await s('Page.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  return {
    kind: 'chromium',
    async goto(u) { const done = new Promise(r => { loaded = r; }); await s('Page.navigate', { url: u }); await done; },
    async json(expr) {
      const r = await s('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expr})))()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
    },
    async shot({ x, y, w, h }, jpeg = false) {
      const r = await s('Page.captureScreenshot', { format: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality: 90 } : {}), captureBeyondViewport: true, clip: { x, y, width: w, height: h, scale: 1 } });
      return Buffer.from(r.data, 'base64');
    },
    async pdf() { const r = await s('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }); return Buffer.from(r.data, 'base64'); },
    async close() { try { await c.send('Browser.close'); } catch { /* gone */ } c.close(); proc.kill(); setTimeout(cleanup, 500); },
  };
}

async function firefox(bin, profile, { width, height, scale }, cleanup) {
  // Quiet, fast and local: no first-run pages, updates or telemetry.
  fs.writeFileSync(path.join(profile, 'user.js'), ['browser.shell.checkDefaultBrowser', 'app.update.enabled', 'datareporting.policy.dataSubmissionEnabled', 'toolkit.telemetry.enabled']
    .map(p => `user_pref("${p}", false);`).join('\n') + '\nuser_pref("browser.startup.homepage", "about:blank");\nuser_pref("startup.homepage_welcome_url", "about:blank");\n');
  const { proc, url } = await launch(bin, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port=0', 'about:blank'], /WebDriver BiDi listening on (ws:\/\/\S+)/);
  const c = await connect(`${url.replace(/\/$/, '')}/session`);
  await c.send('session.new', { capabilities: {} });
  const { contexts } = await c.send('browsingContext.getTree', {});
  const context = contexts[0].context;
  await c.send('browsingContext.setViewport', { context, viewport: { width, height }, devicePixelRatio: scale });
  return {
    kind: 'firefox',
    async goto(u) { await c.send('browsingContext.navigate', { context, url: u, wait: 'complete' }); },
    async json(expr) {
      const r = await c.send('script.evaluate', { expression: `(async () => JSON.stringify(await (${expr})))()`, target: { context }, awaitPromise: true });
      if (r.type === 'exception') throw new Error(r.exceptionDetails?.text || 'script error');
      return r.result.type === 'string' ? JSON.parse(r.result.value) : undefined;
    },
    async shot({ x, y, w, h }, jpeg = false) {
      const r = await c.send('browsingContext.captureScreenshot', { context, origin: 'document', clip: { type: 'box', x, y, width: w, height: h }, ...(jpeg ? { format: { type: 'image/jpeg', quality: 0.9 } } : {}) });
      return Buffer.from(r.data, 'base64');
    },
    async pdf() {
      const r = await c.send('browsingContext.print', { context, background: true, margin: { top: 0, bottom: 0, left: 0, right: 0 }, page: { width: width * 2.54 / 96, height: height * 2.54 / 96 }, shrinkToFit: false });
      return Buffer.from(r.data, 'base64');
    },
    async close() { try { await c.send('session.end', {}); } catch { /* gone */ } c.close(); proc.kill(); setTimeout(cleanup, 500); },
  };
}
