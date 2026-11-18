#!/usr/bin/env node
// End-to-end checks for every feature: tools, runtime (built single file), presenter window, editor, Claude bridge.
// Run with: npm test            (uses a stand-in for the Claude CLI; REAL_CLAUDE=1 also makes one real, paid call)
// Works on a throwaway copy of decks/example; leaves the repository as it found it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import { ROOT, DECKS, DIST } from '../tools/lib.mjs';

const PORT = 4890, BASE = `http://localhost:${PORT}`;
const DECK = 'e2e-test', NEWDECK = 'e2e-new', UNPACKED = 'e2e-unpacked';
const FILE = path.join(DECKS, DECK, 'deck.html');
const LOG = path.join(ROOT, 'tests', '.fake-claude.log');
const results = [];
let server, browser, mock;

/* ── Harness ── */

async function check(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  ✓ ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: expected ≈${b}, got ${a}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = () => fs.readFileSync(FILE, 'utf8');
const section = (id, html = read()) => { const m = new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(html); return m ? m[0] : ''; };
const ids = () => [...read().matchAll(/<section class="slide" id="([^"]+)"/g)].map(m => m[1]);
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await sleep(60); }
}
function cleanup() {
  for (const d of [DECK, NEWDECK, UNPACKED]) fs.rmSync(path.join(DECKS, d), { recursive: true, force: true });
  for (const f of [`${DECK}.html`, 'example.html']) fs.rmSync(path.join(DIST, f), { force: true });
  fs.rmSync(LOG, { force: true });
}

/* ── Setup ── */

cleanup();
fs.cpSync(path.join(DECKS, 'example'), path.join(DECKS, DECK), { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deckelsmouk-e2e-'));
const AI_CONFIG = path.join(TMP, 'config.json'), FAKE_STATE = path.join(TMP, 'claude-state.json');
mock = await startMockAI();
const serverEnv = { ...process.env, DECK_CLAUDE_BIN: path.join(ROOT, 'tests', 'fake-claude.mjs'), FAKE_CLAUDE_LOG: LOG,
  FAKE_CLAUDE_STATE: FAKE_STATE, DECKELSMOUK_CONFIG: AI_CONFIG, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
server = spawn(process.execPath, ['tools/server.mjs', '--port', String(PORT)], { cwd: ROOT, env: serverEnv, stdio: 'ignore' });
await until(() => fetch(`${BASE}/api/decks`).then(r => r.ok), 5000, 'server');
browser = await chromium.launch();
const pageErrors = [];
const newPage = async (ctx, vp = { width: 1500, height: 900 }) => {
  const p = await ctx.newPage();
  await p.setViewportSize(vp);
  p.on('pageerror', e => pageErrors.push(`${p.url()}: ${e.message}`));
  return p;
};

try {
  /* ── Tools ── */
  console.log('\nTools');
  await check('build: one self-contained file with marked slides and animations at the bottom', async () => {
    execFileSync(process.execPath, ['tools/build.mjs', 'example'], { cwd: ROOT });
    const html = fs.readFileSync(path.join(DIST, 'example.html'), 'utf8');
    assert(!/<script[^>]+src=|<link[^>]+stylesheet/.test(html), 'external script or stylesheet left');
    const order = ['SLIDES ====', '===== Slide 1 · title', 'END SLIDES', 'RUNTIME', 'ANIMATIONS'].map(k => html.indexOf(k));
    assert(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]), `markers out of order: ${order}`);
    assert(html.lastIndexOf('<script') === html.indexOf('<script id="deck-animations"'), 'animations are not the last script');
  });
  await check('unpack: built file turns back into identical source', async () => {
    execFileSync(process.execPath, ['tools/unpack.mjs', 'dist/example.html', UNPACKED], { cwd: ROOT });
    for (const f of ['deck.html', 'animations.js'])
      assert(fs.readFileSync(path.join(DECKS, UNPACKED, f), 'utf8') === fs.readFileSync(path.join(DECKS, 'example', f), 'utf8'), `${f} differs`);
  });
  await check('build inlines assets as data URIs', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(DECKS, UNPACKED, 'assets', 'dot.png'), png);
    const f = path.join(DECKS, UNPACKED, 'deck.html');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('</section>', '<img src="assets/dot.png" style="position:absolute;left:0;top:0;width:10px"></section>'));
    execFileSync(process.execPath, ['tools/build.mjs', UNPACKED], { cwd: ROOT });
    const html = fs.readFileSync(path.join(DIST, `${UNPACKED}.html`), 'utf8');
    fs.rmSync(path.join(DIST, `${UNPACKED}.html`));
    assert(html.includes('src="data:image/png;base64,') && !html.includes('assets/dot.png'), 'asset not inlined');
  });
  await check('server refuses writes without X-Deck header, foreign hosts and paths outside the repo', async () => {
    assert((await fetch(`${BASE}/api/deck?deck=${DECK}`, { method: 'PUT', body: '{}' })).status === 403, 'PUT without header allowed');
    const r = await new Promise(ok => { const http = require_http(); http.get({ host: '127.0.0.1', port: PORT, path: '/api/decks', headers: { Host: 'evil.example' } }, ok); });
    assert(r.statusCode === 403, 'foreign Host allowed');
    assert((await fetch(`${BASE}/tools/server.mjs`)).status === 404, 'tools/ served');
    assert((await fetch(`${BASE}/decks/../package.json`)).status === 404, 'traversal served');
  });

  /* ── Runtime (the built single file, opened from disk) ── */
  console.log('\nRuntime (dist/example.html from disk)');
  const ctx = await browser.newContext();
  const deck = await newPage(ctx, { width: 1280, height: 720 });
  const url = 'file://' + path.join(DIST, 'example.html');
  const state = () => deck.evaluate(() => ({ slide: Deck.current, step: Deck.step, steps: Deck.steps(Deck.slides[Deck.current]), hidden: Deck.slides[Deck.current].querySelectorAll('.is-hidden').length }));
  await deck.goto(url);
  await check('opens on the title slide, words effect leaves the headline text intact', async () => {
    await sleep(1600);
    const s = await state();
    assert(s.slide === 0 && s.step === 0, JSON.stringify(s));
    assert((await deck.textContent('#title h1')).trim() === 'Slides that move.', 'headline changed');
  });
  await check('click steps reveal elements one by one; exit hides the card', async () => {
    await deck.keyboard.press('ArrowRight'); await sleep(300);
    let s = await state();
    assert(s.slide === 1 && s.steps === 4 && s.hidden === 4, `entering agenda: ${JSON.stringify(s)}`);
    for (let k = 1; k <= 3; k++) { await deck.keyboard.press('Space'); await sleep(150); }
    assert((await state()).hidden === 0, 'all should be visible at step 3');
    await deck.keyboard.press('ArrowRight'); await sleep(1300);
    s = await state();
    assert(s.step === 4 && s.hidden === 1 && await deck.$eval('#agenda .card', e => e.classList.contains('is-hidden')), `exit: ${JSON.stringify(s)}`);
  });
  await check('back goes to the previous state instantly', async () => {
    await deck.keyboard.press('ArrowLeft'); await sleep(50);
    const s = await state();
    assert(s.step === 3 && s.hidden === 0, JSON.stringify(s));
    await deck.keyboard.press('ArrowRight'); await sleep(50);
  });
  await check('count effect counts up to the written value; draw effect animates SVG strokes', async () => {
    await deck.keyboard.press('ArrowRight'); await sleep(250);
    const mid = await deck.textContent('#numbers .stat');
    const drawing = await deck.$eval('#numbers svg path', p => p.getAnimations().length);
    assert(mid !== '97.4 %' && /%/.test(mid), `count did not start low: "${mid}"`);
    assert(drawing > 0, 'path not animating');
    await sleep(1800);
    assert((await deck.textContent('#numbers .stat')) === '97.4 %', 'count end value wrong');
  });
  await check('magic move glides the shared element between slides', async () => {
    await deck.keyboard.press('ArrowRight'); await sleep(50); // numbers step 1
    await deck.keyboard.press('ArrowRight'); await sleep(900); // magic-a
    await deck.keyboard.press('ArrowRight'); await sleep(80); // magic-b
    const n = await deck.$eval('#magic-b [data-magic=box]', e => e.getAnimations().filter(a => a.playState === 'running').length);
    assert(n > 0, 'no magic animation running');
  });
  await check('slide script draws on canvas; K pauses and resumes it', async () => {
    await deck.keyboard.press('ArrowRight'); await sleep(700);
    const pix = () => deck.$eval('#orbit canvas', c => c.toDataURL());
    const a = await pix(); await sleep(200);
    assert(a !== await pix(), 'canvas is not animating');
    await deck.keyboard.press('k'); await sleep(150);
    const p1 = await pix(); await sleep(300);
    assert(await deck.evaluate(() => Deck.paused) && p1 === await pix(), 'still moving while paused');
    await deck.keyboard.press('k'); await sleep(200);
    assert(p1 !== await pix(), 'did not resume');
  });
  await check('B toggles the black screen', async () => {
    await deck.keyboard.press('b');
    assert(await deck.evaluate(() => document.body.classList.contains('is-black') && Deck.paused), 'not black');
    await deck.keyboard.press('b');
    assert(!(await deck.evaluate(() => document.body.classList.contains('is-black'))), 'still black');
  });
  await check('zoom transition to the last slide; End and Home jump', async () => {
    await deck.keyboard.press('ArrowRight'); await deck.keyboard.press('ArrowRight'); await sleep(700);
    assert((await state()).slide === 6, 'not on last slide');
    await deck.keyboard.press('Home'); await sleep(100);
    assert((await state()).slide === 0, 'Home failed');
    await deck.keyboard.press('End'); await sleep(100);
    assert((await state()).slide === 6, 'End failed');
  });
  await check('URL hash: #3.1 and #slide-id open the right place and stay in sync', async () => {
    await deck.goto(url + '#numbers.1'); await sleep(200);
    let s = await state();
    assert(s.slide === 2 && s.step === 1, JSON.stringify(s));
    await deck.keyboard.press('ArrowRight'); await sleep(50);
    assert(deck.url().endsWith('#4.0'), deck.url());
    await deck.goto(url + '#2.3'); await deck.reload(); await sleep(200);
    s = await state();
    assert(s.slide === 1 && s.step === 3, JSON.stringify(s));
  });
  await check('?print shows every slide in its final state', async () => {
    const pr = await newPage(ctx);
    await pr.goto(url + '?print'); await sleep(200);
    const r = await pr.evaluate(() => ({ vis: [...document.querySelectorAll('.slide')].every(s => getComputedStyle(s).visibility === 'visible'), hidden: [...document.querySelectorAll('.is-hidden')].map(e => e.className) }));
    assert(r.vis, 'a slide is invisible');
    assert(r.hidden.length === 1 && r.hidden[0].includes('card'), `unexpected hidden: ${r.hidden}`);
    await pr.close();
  });
  await check('P opens the presenter window, which follows and drives the deck (single file from disk)', async () => {
    await deck.goto(url + '#2.0'); await sleep(200);
    const [pv] = await Promise.all([ctx.waitForEvent('page'), deck.keyboard.press('p')]);
    pv.on('pageerror', e => pageErrors.push(`presenter: ${e.message}`));
    await pv.waitForLoadState();
    assert(pv.url().includes('?presenter'), pv.url());
    await until(async () => (await pv.textContent('#pv-pos')).includes('Slide 2 of 7'), 3000, 'presenter position');
    assert((await pv.textContent('#pv-notes')).includes('Click through the three points'), 'notes missing');
    assert((await pv.$eval('#pv-notes', e => e.isContentEditable)) === false, 'notes should be read-only from a built file');
    await pv.click('#pv-next-btn');
    await until(async () => (await state()).step === 1, 2000, 'deck to follow presenter');
    await deck.keyboard.press('ArrowRight');
    await until(async () => (await pv.textContent('#pv-step')).includes('click 2 of 4'), 2000, 'presenter to follow deck');
    const hiddenNow = await pv.$$eval('#pv-now .is-hidden', e => e.length);
    assert(hiddenNow === 2, `presenter "now" view should hide the 3rd point and the card at step 2, hides ${hiddenNow}`);
    await pv.keyboard.press('b');
    await until(() => deck.evaluate(() => document.body.classList.contains('is-black')), 2000, 'black from presenter');
    await until(async () => (await pv.textContent('#pv-flag')) === 'BLACK SCREEN', 2000, 'presenter flag');
    await pv.keyboard.press('b');
    await until(() => deck.evaluate(() => !document.body.classList.contains('is-black')), 2000, 'black off');
  });
  await check('closing the presentation closes the notes window (single file from disk)', async () => {
    const pv = ctx.pages().find(p => p.url().includes('?presenter'));
    assert(pv, 'notes window missing');
    const closed = pv.waitForEvent('close', { timeout: 6000 });
    await deck.close();
    await closed;
  });
  await ctx.close();

  /* ── Editor ── */
  console.log('\nEditor');
  const ectx = await browser.newContext();
  const ed = await newPage(ectx);
  const fr = ed.frameLocator('#frame');
  const scale = () => ed.evaluate(() => document.querySelector('#frame').contentWindow.Deck.scale);
  const boxIn = sel => ed.evaluate(s => { const d = document.querySelector('#frame').contentDocument, w = d.defaultView; const sl = d.querySelector('.slide.is-current').getBoundingClientRect(), r = d.querySelector(s).getBoundingClientRect(), k = w.Deck.scale; return { x: Math.round((r.left - sl.left) / k), y: Math.round((r.top - sl.top) / k), w: Math.round(r.width / k), h: Math.round(r.height / k) }; }, sel);
  const selCount = () => ed.$$eval('#overlay .sel-box:not([style*="dotted"])', e => e.length);
  const gotoSlide = async n => { await ed.goto(`${BASE}/?deck=${DECK}&slide=${n}`); await until(() => ed.evaluate(() => !!document.querySelector('#frame').contentWindow.Deck?.show), 5000, 'editor'); await sleep(400); };
  const clickAt = async (sel, dx = 20, dy = 20) => { const b = await fr.locator(sel).boundingBox(); await ed.mouse.click(b.x + dx, b.y + dy); await sleep(120); return b; };
  const saved = () => until(async () => (await ed.textContent('#save-state')) === 'Saved', 3000, 'save');

  await check('start page lists decks; creating a deck opens it in the editor', async () => {
    await ed.goto(BASE + '/'); await sleep(300);
    assert(await ed.locator(`.deck-card[href*="${DECK}"]`).count() === 1, 'test deck not listed');
    await ed.fill('#new-deck input[name=name]', NEWDECK);
    await ed.fill('#new-deck input[name=title]', 'Made in a test');
    await Promise.all([ed.waitForURL(`**/?deck=${NEWDECK}`), ed.click('#new-deck button')]);
    assert(fs.existsSync(path.join(DECKS, NEWDECK, 'deck.html')), 'deck folder missing');
    await until(async () => (await ed.inputValue('#deck-title')) === 'Made in a test', 3000, 'title');
  });

  await gotoSlide(2);
  await check('click selects an object; prompt bar shows the selection', async () => {
    await clickAt('#agenda .card');
    assert(await selCount() === 1, 'no selection box');
    assert((await ed.textContent('#claude-ctx')).startsWith('Slide 2'), await ed.textContent('#claude-ctx'));
  });
  await check('drag moves the object and saves it to deck.html', async () => {
    const k = await scale(), b = await fr.locator('#agenda .card').boundingBox(), before = await boxIn('#agenda .card');
    await ed.keyboard.down('Alt'); // no snapping, so the offset is exact
    await ed.mouse.move(b.x + 30, b.y + 30); await ed.mouse.down();
    await ed.mouse.move(b.x + 30 - 100 * k, b.y + 30 + 37 * k, { steps: 10 }); await ed.mouse.up();
    await ed.keyboard.up('Alt');
    await saved();
    const after = await boxIn('#agenda .card');
    near(after.x, before.x - 100, 3, 'x'); near(after.y, before.y + 37, 3, 'y');
    assert(new RegExp(`left: ?${after.x}px`).test(section('agenda')), 'position not in file');
  });
  await check('snapping: an edge near the slide centre snaps onto it', async () => {
    const k = await scale(), b = await fr.locator('#agenda .card').boundingBox(), bx = await boxIn('#agenda .card');
    await ed.mouse.move(b.x + 30, b.y + 30); await ed.mouse.down();
    await ed.mouse.move(b.x + 30 + (963 - bx.x) * k, b.y + 30, { steps: 8 });
    const guides = await ed.$$eval('#overlay .guide', e => e.length);
    await ed.mouse.up(); await saved();
    assert(guides > 0, 'no guide shown');
    near((await boxIn('#agenda .card')).x, 960, 0.5, 'snapped x');
  });
  await check('undo and redo', async () => {
    await ed.keyboard.press('Meta+z'); await saved(); await sleep(200);
    const u = await boxIn('#agenda .card');
    assert(u.x !== 960, 'undo did not move it back');
    await ed.keyboard.press('Meta+Shift+z'); await saved(); await sleep(200);
    near((await boxIn('#agenda .card')).x, 960, 0.5, 'redo x');
  });
  await check('arrow keys nudge (1 px, Shift 10 px) as one undo step', async () => {
    await clickAt('#agenda .card');
    const a = await boxIn('#agenda .card');
    for (let i = 0; i < 3; i++) await ed.keyboard.press('ArrowRight');
    await ed.keyboard.press('Shift+ArrowDown');
    await sleep(600); await saved();
    const b = await boxIn('#agenda .card');
    assert(b.x === a.x + 3 && b.y === a.y + 10, `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  });
  await check('resize handle changes the width', async () => {
    const k = await scale(), a = await boxIn('#agenda .card');
    const h = await ed.locator('#overlay .handle[data-h="e"]').boundingBox();
    await ed.mouse.move(h.x + 5, h.y + 5); await ed.mouse.down();
    await ed.mouse.move(h.x + 5 + 60 * k, h.y + 5, { steps: 6 }); await ed.mouse.up(); await saved();
    near((await boxIn('#agenda .card')).w, a.w + 60, 2, 'width');
  });
  await check('double-click edits text in place', async () => {
    const b = await fr.locator('#agenda h2').boundingBox();
    await ed.mouse.dblclick(b.x + 30, b.y + b.height / 2); await sleep(150);
    await ed.keyboard.press('End'); await ed.keyboard.type(' — edited'); await ed.keyboard.press('Escape'); await saved();
    assert(section('agenda').includes('Each click reveals one step — edited</h2>'), 'text not saved');
  });
  await check('second click goes inside a group; ⌥-click picks the exact element', async () => {
    await clickAt('#agenda li:nth-child(2)', 200, 10);
    assert((await ed.textContent('.sel-label')).startsWith('ul'), 'first click should select the list');
    await clickAt('#agenda li:nth-child(2)', 200, 10);
    assert((await ed.textContent('.sel-label')).startsWith('li'), 'second click should select the item');
    await ed.keyboard.press('Escape');
    const b = await fr.locator('#agenda li:nth-child(1) .mono').boundingBox();
    await ed.keyboard.down('Alt'); await ed.mouse.click(b.x + 5, b.y + 5); await ed.keyboard.up('Alt'); await sleep(100);
    assert((await ed.textContent('.sel-label')).startsWith('span'), 'alt-click should select the span');
  });
  await check('lasso selects several objects; align right lines them up', async () => {
    await ed.keyboard.press('Escape');
    const k = await scale(), sl = await fr.locator('#agenda').boundingBox();
    await ed.mouse.move(sl.x + 40 * k, sl.y + 1040 * k); await ed.mouse.down();
    await ed.mouse.move(sl.x + 900 * k, sl.y + 100 * k, { steps: 8 }); await ed.mouse.up(); await sleep(150);
    assert(await selCount() === 2, `lasso selected ${await selCount()}`);
    await ed.click('[data-menu=arrange]'); await ed.click('[data-cmd=align-right]'); await saved();
    const a = await boxIn('#agenda h2'), b = await boxIn('#agenda ul');
    near(a.x + a.w, b.x + b.w, 1, 'right edges');
    await ed.keyboard.press('Meta+z'); await saved();
  });
  await check('insert heading, type, delete', async () => {
    await ed.click('[data-cmd=insert-heading]'); await sleep(150);
    await ed.keyboard.type('Inserted heading'); await ed.keyboard.press('Escape'); await saved();
    assert(/data-el="heading"[^>]*>Inserted heading<\/h2>/.test(section('agenda')), 'heading not saved');
    await ed.keyboard.press('Backspace'); await saved();
    assert(!section('agenda').includes('Inserted heading'), 'heading not deleted');
  });
  await check('shapes, duplicate (⌘D), copy and paste (⌘C ⌘V)', async () => {
    await ed.click('[data-menu=shapes]'); await ed.click('[data-cmd=shape-ellipse]'); await saved();
    assert(section('agenda').includes('data-el="shape"'), 'shape missing');
    await fr.locator('body').press('Meta+d'); await saved();
    assert(section('agenda').includes('data-el="shape-2"'), 'duplicate missing');
    await fr.locator('body').press('Meta+c');
    await fr.locator('body').press('Meta+v'); await sleep(300); await saved();
    assert(section('agenda').includes('data-el="shape-3"'), 'paste missing');
  });
  await check('layer order: send to back', async () => {
    await ed.click('[data-menu=arrange]'); await ed.click('[data-cmd=back]'); await saved();
    const s = section('agenda');
    assert(s.indexOf('data-el="shape-3"') < s.indexOf('<h2'), 'not sent to back');
    for (let i = 0; i < 4; i++) { await ed.keyboard.press('Meta+z'); await saved(); }
    await sleep(200);
    assert(!section('agenda').includes('data-el="shape'), 'undo of shapes failed');
  });
  await check('insert an image from a file (upload into assets/)', async () => {
    const png = await ed.screenshot({ clip: { x: 0, y: 0, width: 64, height: 36 } });
    await ed.setInputFiles('#file-input', { name: 'Shot.png', mimeType: 'image/png', buffer: png });
    await until(() => section('agenda').includes('src="assets/shot.png"'), 5000, 'image in deck');
    assert(fs.existsSync(path.join(DECKS, DECK, 'assets', 'shot.png')), 'file not uploaded');
  });
  await check('Design panel: typing X moves the selection', async () => {
    await clickAt('#agenda .card');
    await ed.click('.tabs button[data-tab=design]');
    await ed.fill('[data-k=x]', '500'); await ed.press('[data-k=x]', 'Tab'); await saved();
    const got = await boxIn('#agenda .card');
    assert(got.x === 500, `x not applied: ${JSON.stringify(got)}, selected ${await ed.textContent('.sel-label').catch(() => '?')}`);
  });
  await check('Design panel: theme colour swatch and type style', async () => {
    await clickAt('#agenda h2');
    await ed.click('.swatch[data-swatch=color][data-var="var(--accent-2)"]'); await saved();
    assert(/<h2[^>]*color: var\(--accent-2\)/.test(section('agenda')), 'colour not set');
    await ed.selectOption('[data-k=type]', 'h1'); await saved();
    assert(/<h2 class="h1"/.test(section('agenda')), 'type class not set');
  });
  await check('Animate panel: effect, step and exit become attributes', async () => {
    await clickAt('#agenda h2');
    await ed.click('.tabs button[data-tab=animate]');
    await ed.selectOption('[data-k=anim]', 'zoom'); await saved();
    await ed.fill('[data-k=step]', '2'); await ed.press('[data-k=step]', 'Tab'); await saved();
    await ed.selectOption('[data-k=out]', 'blur'); await saved();
    const h2 = /<h2[^>]*>/.exec(section('agenda'))[0];
    assert(/data-anim="zoom"/.test(h2) && /data-step="2"/.test(h2) && /data-out="blur"/.test(h2) && /data-out-step="3"/.test(h2), h2);
    assert(await ed.locator('.anim-item').count() >= 5, 'animation list incomplete');
  });
  await check('Animate panel: "One per click" orders a multi-selection', async () => {
    await gotoSlide(1);
    await clickAt('#title .lead');
    for (const sel of ['#title h1', '#title .eyebrow']) { const b = await fr.locator(sel).boundingBox(); await ed.keyboard.down('Shift'); await ed.mouse.click(b.x + b.width / 2, b.y + 10); await ed.keyboard.up('Shift'); }
    assert(await selCount() === 3, `shift-click selected ${await selCount()}`);
    await ed.click('.tabs button[data-tab=animate]');
    await ed.click('[data-seq=clicks]'); await saved();
    const steps = [...section('title').matchAll(/data-step="(\d)"/g)].map(m => m[1]).join('');
    assert(steps === '123', `steps ${steps}`);
    await ed.keyboard.press('Meta+z'); await saved();
  });
  await check('Slide panel: title and transition', async () => {
    await ed.click('.tabs button[data-tab=slide]');
    await ed.fill('[data-k=title]', 'Opening'); await ed.press('[data-k=title]', 'Tab');
    await ed.selectOption('[data-k=transition]', 'push'); await saved();
    assert(/<section class="slide" id="title" data-title="Opening" data-transition="push"/.test(read()), /<section[^>]*id="title"[^>]*>/.exec(read())[0]);
  });
  await check('Code panel edits the HTML of the selection', async () => {
    await gotoSlide(2);
    await clickAt('#agenda .card');
    await ed.click('.tabs button[data-tab=code]');
    const t = await ed.inputValue('#code-text');
    await ed.fill('#code-text', t.replace('I leave at step 4', 'Edited as code'));
    await ed.click('#code-apply'); await saved();
    assert(section('agenda').includes('Edited as code'), 'not applied');
  });
  await check('speaker notes pane writes the slide notes (and clearing removes them)', async () => {
    await ed.click('#notes-edit');
    await ed.keyboard.press('Meta+a'); await ed.keyboard.type('First line'); await ed.keyboard.press('Enter'); await ed.keyboard.type('Second **line**');
    await ed.click('#claude-input'); await saved();
    assert(/<aside class="notes"><p>First line<\/p><p>Second \*\*line\*\*<\/p><\/aside>/.test(section('agenda')), /<aside[\s\S]*?<\/aside>/.exec(section('agenda'))?.[0]);
    await gotoSlide(3);
    assert((await ed.textContent('#notes-edit')).includes('The number and the chart'), 'notes of slide 3 not shown');
    await ed.click('#notes-edit'); await ed.keyboard.press('Meta+a'); await ed.keyboard.press('Backspace');
    await ed.click('#claude-input'); await saved();
    assert(!section('numbers').includes('<aside'), 'empty notes not removed');
    await ed.keyboard.press('Escape');
  });
  await check('slides: new from layout, duplicate, delete', async () => {
    const n = ids().length;
    await ed.click('[data-menu=newslide]'); await ed.click('[data-cmd=slide-bullets]'); await saved();
    assert(ids().length === n + 1 && ids()[3].startsWith('slide-'), `after add: ${ids()}`);
    await ed.click('[data-cmd=slide-duplicate]'); await saved();
    assert(ids()[4] === ids()[3] + '-copy', `duplicate: ${ids()}`);
    await ed.click('[data-cmd=slide-delete]'); await saved();
    await ed.click('[data-cmd=slide-delete]'); await saved();
    assert(ids().length === n, `after delete: ${ids()}`);
    const markers = [...read().matchAll(/<!-- ===== Slide (\d+) · ([\w-]+) ===== -->/g)].map(m => +m[1]);
    assert(markers.every((v, i) => v === i + 1), `markers not renumbered: ${markers}`);
  });
  await check('slides: drag in the slide list to reorder', async () => {
    const before = ids();
    const t = await ed.locator('#thumbs').boundingBox(), th = ed.frameLocator('#thumbs');
    const a = await th.locator('.slide').nth(0).boundingBox(), c = await th.locator('.slide').nth(2).boundingBox();
    await ed.mouse.move(a.x + 40, a.y + 20); await ed.mouse.down();
    await ed.mouse.move(c.x + 40, c.y + c.height - 4, { steps: 10 }); await ed.mouse.up(); await saved();
    const after = ids();
    assert(after[2] === before[0] && after[0] === before[1], `${before} → ${after}`);
    await ed.keyboard.press('Meta+z'); await saved();
    assert(ids().join() === before.join(), 'undo of reorder failed');
  });
  await check('edits made outside the editor appear live and can be undone', async () => {
    await gotoSlide(1);
    fs.writeFileSync(FILE, read().replace('Slides that', 'Decks that'));
    await until(async () => (await fr.locator('#title h1').textContent()).startsWith('Decks that'), 4000, 'live reload');
    await ed.keyboard.press('Escape'); await fr.locator('body').press('Meta+z'); await saved();
    assert(read().includes('Slides that'), 'undo of outside edit failed');
  });
  await check('Play previews the slide in place; Esc closes', async () => {
    await ed.click('[data-cmd=preview]');
    await until(() => ed.evaluate(() => document.querySelector('#preview-frame').contentWindow.Deck?.mode === 'present'), 4000, 'preview');
    await ed.keyboard.press('Escape');
    await until(() => ed.isHidden('#preview'), 2000, 'preview closed');
  });
  await check('Export builds dist/<deck>.html with assets inlined', async () => {
    await ed.click('[data-cmd=export]');
    await until(async () => (await ed.textContent('#toast')).includes(`dist/${DECK}.html`), 5000, 'toast');
    const html = fs.readFileSync(path.join(DIST, `${DECK}.html`), 'utf8');
    assert(html.includes('data:image/png;base64,') && !html.includes('src="assets/'), 'asset not inlined');
  });
  await check('Present opens the deck and a separate notes window; notes edited there are saved', async () => {
    await gotoSlide(2);
    const pages = [];
    ectx.on('page', p => pages.push(p));
    await ed.click('[data-cmd=present]');
    const show = await until(() => pages.find(p => !p.url().includes('presenter') && p.url().includes('deck.html')), 4000, 'deck tab');
    assert(show.url().includes('?notes'), show.url());
    await show.waitForLoadState();
    // Either the notes window opens at once, or (pop-up blocked) the deck asks for one click first.
    await until(async () => pages.some(p => p.url().includes('?presenter')) || await show.isVisible('.deck-notes-ask'), 4000, 'notes window or start card');
    let pv = pages.find(p => p.url().includes('?presenter'));
    if (!pv) {
      await show.mouse.click(600, 400);
      pv = await until(() => pages.find(p => p.url().includes('?presenter')), 3000, 'notes window');
      await sleep(200);
      assert((await show.evaluate(() => Deck.step)) === 0, 'the start click must not advance');
    }
    await pv.waitForLoadState();
    await until(async () => (await pv.textContent('#pv-pos')).includes('Slide 2'), 3000, 'notes window synced');
    await until(() => pv.$eval('#pv-notes', e => e.isContentEditable), 3000, 'notes editable');
    await pv.click('#pv-notes'); await pv.keyboard.press('Meta+a'); await pv.keyboard.type('Rehearsal note');
    await pv.click('#pv-time'); // blur saves
    await until(() => section('agenda').includes('<aside class="notes"><p>Rehearsal note</p></aside>'), 3000, 'notes saved to deck.html');
    await until(async () => (await ed.textContent('#notes-edit')) === 'Rehearsal note', 4000, 'editor shows the new notes');
    await pv.keyboard.press('ArrowRight');
    await until(() => show.evaluate(() => Deck.step === 1), 2000, 'keys in notes window drive the deck');
  });
  await check('reloading the deck keeps the notes window; closing it closes the notes window', async () => {
    const show = ectx.pages().find(p => p.url().includes('deck.html?notes'));
    const pv = ectx.pages().find(p => p.url().includes('?presenter'));
    assert(show && pv, 'windows missing');
    await show.goto(show.url().replace(/#.*$/, '') + '#3.0');
    await sleep(3000);
    assert(!pv.isClosed(), 'notes window closed on reload');
    await until(async () => (await pv.textContent('#pv-pos')).includes('Slide 3'), 3000, 'notes window follows the reloaded deck');
    const closed = pv.waitForEvent('close', { timeout: 6000 });
    await show.close();
    await closed;
  });
  await check('Claude: request with selection is sent, changes load live, ⌘Z undoes them', async () => {
    fs.rmSync(LOG, { force: true });
    await gotoSlide(2);
    await clickAt('#agenda .card');
    await ed.click('#claude-new');
    await ed.fill('#claude-input', 'Make the card stand out');
    await ed.click('#claude-send');
    await until(async () => (await ed.textContent('#claude-log')).includes('Changes loaded'), 8000, 'Claude run');
    const call = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').pop());
    assert(call.prompt.includes('Request: Make the card stand out'), 'request missing');
    assert(call.prompt.includes('id="agenda"') && call.prompt.includes('class="card"') && /x=\d+ y=\d+ w=\d+ h=\d+/.test(call.prompt), 'selection context missing:\n' + call.prompt);
    assert(call.args.includes('acceptEdits') && !call.args.includes('--resume'), `args: ${call.args}`);
    assert(/data-claude="touched"/.test(section('agenda')), 'file not changed');
    await until(() => fr.locator('#agenda[data-claude="touched"]').count(), 3000, 'editor reloaded');
    const log = await ed.textContent('#claude-log');
    assert(log.includes('✎ Edit decks/e2e-test/deck.html') && log.includes('Marked the slide.'), log);
    await ed.keyboard.press('Escape'); await fr.locator('body').press('Meta+z'); await saved();
    assert(!read().includes('data-claude'), 'undo failed');
  });
  await check('Claude: follow-ups continue the conversation; New chat starts fresh', async () => {
    await ed.fill('#claude-input', 'And again'); await ed.click('#claude-send');
    await until(async () => !(await ed.isDisabled('#claude-send')), 8000, 'second run');
    let call = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').pop());
    assert(call.args.includes('--resume') && call.args.includes('sess-1'), `no resume: ${call.args}`);
    await ed.click('#claude-new'); await sleep(200);
    await ed.fill('#claude-input', 'Fresh'); await ed.click('#claude-send');
    await until(async () => !(await ed.isDisabled('#claude-send')), 8000, 'third run');
    call = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').pop());
    assert(!call.args.includes('--resume'), 'resumed after New chat');
  });
  await check('Claude: Stop ends a long run and unlocks the editor', async () => {
    await ed.fill('#claude-input', 'SLOW request'); await ed.click('#claude-send');
    await until(() => ed.isVisible('#busy'), 3000, 'busy overlay');
    await ed.click('#busy [data-cmd=claude-stop]');
    await until(() => ed.isHidden('#busy'), 5000, 'unlock');
    assert((await ed.textContent('#claude-log')).includes('Stopped'), 'no Stopped message');
  });
  /* ── AI providers ── */
  console.log('\nAI providers');
  ed.on('dialog', d => d.accept());
  const openSettings = async id => {
    if (await ed.isHidden('#ai-dialog')) await ed.click('#ai-provider');
    await ed.click(`#ai-list [data-p="${id}"]`); await sleep(150);
  };
  const ask = async (prompt, done = 'Changes loaded') => {
    await ed.fill('#claude-input', prompt); await ed.click('#claude-send');
    await until(async () => !(await ed.isDisabled('#claude-send')), 10000, 'AI run');
    await sleep(300);
    const log = await ed.textContent('#claude-log');
    if (done) assert(log.includes(done), `log: ${log.slice(-500)}`);
    return log;
  };
  const AGENDA_NEW = (title, notes = false) => `<section class="slide" id="agenda" data-title="Agenda">
  <h2 class="h2" data-anim="pop" style="position:absolute;left:140px;top:120px;width:1200px">${title}</h2>
  <ul class="list" style="position:absolute;left:140px;top:330px;width:1100px"><li data-anim="left" data-step="1">One</li></ul>${notes ? '\n  <aside class="notes"><p>New notes</p></aside>' : ''}
</section>`;

  await check('settings list every provider; Claude Code shows who is signed in', async () => {
    await gotoSlide(2);
    assert((await ed.textContent('#ai-provider')) === 'Claude Code', 'default provider');
    await ed.click('#ai-provider');
    const names = await ed.$$eval('#ai-list [data-p]', b => b.map(x => x.dataset.p).join());
    assert(names === 'claude-code,anthropic,ollama,lmstudio,openai', names);
    await until(async () => (await ed.textContent('#cc-status')).includes('fake@example.com'), 5000, 'status');
  });
  await check('Claude Code sign-out and browser sign-in', async () => {
    await ed.click('#cc-logout');
    await until(async () => (await ed.textContent('#cc-status')).startsWith('Not signed in'), 5000, 'signed out');
    await ed.click('[data-login="claudeai"]');
    await until(async () => (await ed.innerHTML('#cc-status')).includes('claude.ai/oauth/authorize'), 5000, 'sign-in link');
    await until(async () => (await ed.textContent('#cc-status')).includes('fake@example.com'), 10000, 'signed in again');
    const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => c.args[0] === 'auth').map(c => c.args.slice(1).join(' '));
    assert(calls.includes('logout') && calls.includes('login --claudeai'), calls.join(' | '));
  });
  await check('LM Studio: token is required, stored privately and never sent back to the browser', async () => {
    await openSettings('lmstudio');
    await ed.fill('[data-f=baseUrl]', `${mock.url}/v1`); await ed.press('[data-f=baseUrl]', 'Tab');
    await until(async () => (await ed.textContent('#conn')).includes('token is required'), 5000, '401 shown');
    await ed.fill('[data-f=apiKey]', 'lm-secret-token'); await ed.press('[data-f=apiKey]', 'Tab');
    await until(async () => (await ed.textContent('#conn')).includes('2 models'), 5000, 'connected');
    const pub = await (await fetch(`${BASE}/api/ai`)).text();
    assert(!pub.includes('lm-secret-token') && pub.includes('••••oken'), 'key leaked or no hint');
    assert(JSON.parse(fs.readFileSync(AI_CONFIG, 'utf8')).providers.lmstudio.apiKey === 'lm-secret-token', 'key not stored');
    assert((fs.statSync(AI_CONFIG).mode & 0o077) === 0, 'config readable by others');
    await ed.selectOption('#model-pick', 'mock-large');
    await ed.click('#ai-use');
    await until(async () => (await ed.textContent('#ai-provider')) === 'LM Studio', 3000, 'chip');
    await until(async () => (await ed.inputValue('#claude-model')) === 'mock-large', 3000, 'model in bar');
  });
  await check('LM Studio: edit blocks are applied (slide, theme CSS, animations.js) and notes are kept', async () => {
    await clickAt('#agenda .card');
    mock.answer = `<<<REPLACE_SLIDE id="agenda">>>\n${AGENDA_NEW('Rewritten by a local model')}\n<<<END>>>
<<<APPEND_CSS>>>\n.shine { color: gold; }\n<<<END>>>
<<<APPEND_JS>>>\n// Pops with a spin.\nDeck.effect('spin-pop', { from: { opacity: 0, rotate: '-90deg' } });\n<<<END>>>
<<<MESSAGE>>>Rewrote the agenda and added a spin-pop effect.<<<END>>>`;
    const log = await ask('Make the agenda punchier');
    assert(log.includes('Rewrote the agenda') && log.includes('Replaced slide agenda'), log.slice(-300));
    const sec = section('agenda');
    assert(sec.includes('Rewritten by a local model') && sec.includes('Rehearsal note'), 'slide not replaced or notes lost');
    assert(/\.shine \{ color: gold; \}\s*\n<\/style>/.test(read()), 'css not in theme');
    assert(fs.readFileSync(path.join(DECKS, DECK, 'animations.js'), 'utf8').includes("Deck.effect('spin-pop'"), 'js not appended');
    await until(() => fr.locator('#agenda h2:has-text("Rewritten")').count(), 3000, 'editor reloaded');
    const req = mock.requests.filter(r => r.path === '/v1/chat/completions').pop();
    assert(req.headers.authorization === 'Bearer lm-secret-token', 'no token sent');
    assert(req.body.model === 'mock-large' && req.body.stream === true, JSON.stringify(req.body).slice(0, 200));
    const [sys, user] = req.body.messages;
    assert(sys.role === 'system' && sys.content.includes('<<<REPLACE_SLIDE') && sys.content.includes('data-step'), 'system prompt');
    assert(user.content.includes('Request: Make the agenda punchier') && user.content.includes('class="card"') && user.content.includes('Current slide, complete HTML'), 'user prompt');
  });
  await check('undo takes back everything the model changed', async () => {
    await ed.keyboard.press('Escape'); await fr.locator('body').press('Meta+z'); await saved(); await sleep(300);
    assert(!read().includes('Rewritten by a local model') && !read().includes('.shine'), 'deck not restored');
    assert(!fs.readFileSync(path.join(DECKS, DECK, 'animations.js'), 'utf8').includes('spin-pop'), 'animations.js not restored');
  });
  await check('follow-up requests carry the conversation', async () => {
    mock.answer = `<<<REPLACE_SLIDE id="agenda">>>\n${AGENDA_NEW('Second pass')}\n<<<END>>>\n<<<MESSAGE>>>Second pass done.<<<END>>>`;
    await ask('Shorter');
    const msgs = mock.requests.filter(r => r.path === '/v1/chat/completions').pop().body.messages;
    assert(msgs.length === 4 && msgs[2].role === 'assistant' && msgs[2].content.includes('Rewrote the agenda'), msgs.map(m => m.role).join());
    await ed.keyboard.press('Escape'); await fr.locator('body').press('Meta+z'); await saved();
  });
  await check('broken answers are refused: invalid JS, a non-slide, or no edit format', async () => {
    const before = read(), beforeJs = fs.readFileSync(path.join(DECKS, DECK, 'animations.js'), 'utf8');
    mock.answer = `<<<REPLACE_SLIDE id="agenda">>>\n<div>not a slide</div>\n<<<END>>>\n<<<APPEND_JS>>>\nDeck.effect('x', {\n<<<END>>>\n<<<MESSAGE>>>Oops.<<<END>>>`;
    let log = await ask('Break it', null);
    assert(log.includes('Skipped: REPLACE_SLIDE agenda') && log.includes('Skipped: APPEND_JS'), log.slice(-400));
    mock.answer = 'Sure! Here is a nicer slide: <h1>Hi</h1>';
    log = await ask('Talk instead', null);
    assert(log.includes('did not answer in the edit format'), log.slice(-300));
    assert(read() === before && fs.readFileSync(path.join(DECKS, DECK, 'animations.js'), 'utf8') === beforeJs, 'files changed');
  });
  await check('Stop ends a streaming answer without changing anything', async () => {
    const before = read();
    mock.slow = true;
    mock.answer = `<<<REPLACE_SLIDE id="agenda">>>\n${AGENDA_NEW('Should never land')}\n<<<END>>>`;
    await ed.fill('#claude-input', 'Slow one'); await ed.click('#claude-send');
    await until(async () => (await ed.textContent('#claude-log')).includes('writing ('), 5000, 'progress');
    assert((await ed.textContent('#busy-text')) === 'LM Studio is editing the deck…', await ed.textContent('#busy-text'));
    await ed.click('#busy [data-cmd=claude-stop]');
    await until(() => ed.isHidden('#busy'), 5000, 'unlock');
    mock.slow = false;
    assert((await ed.textContent('#claude-log')).includes('Stopped') && read() === before, 'not stopped cleanly');
  });
  await check('Ollama (native API): context length is sent; a new slide is added after the current one', async () => {
    await openSettings('ollama');
    await ed.fill('[data-f=baseUrl]', mock.url); await ed.press('[data-f=baseUrl]', 'Tab');
    await until(async () => (await ed.textContent('#conn')).includes('1 model'), 5000, 'connected');
    await ed.fill('[data-f=numCtx]', '32768'); await ed.press('[data-f=numCtx]', 'Tab'); await sleep(200);
    await ed.click('#ai-use');
    await until(async () => (await ed.textContent('#ai-provider')) === 'Ollama', 3000, 'chip');
    mock.answer = `<<<ADD_SLIDE after="agenda">>>\n<section class="slide" id="agenda" data-title="Why"><h2 class="h2" style="position:absolute;left:140px;top:120px;width:1200px">Why it matters</h2></section>\n<<<END>>>\n<<<MESSAGE>>>Added a slide.<<<END>>>`;
    await ask('Add a why slide');
    const order = ids();
    assert(order[order.indexOf('agenda') + 1] === 'agenda-2', `order: ${order}`);
    const req = mock.requests.filter(r => r.path === '/api/chat').pop();
    assert(req.body.options.num_ctx === 32768 && req.body.model === 'qwen-mock' && req.body.messages[0].role === 'system', JSON.stringify(req.body).slice(0, 300));
    await until(async () => (await ed.frameLocator('#thumbs').locator('.slide').count()) === order.length, 3000, 'slide list updated');
    await ed.keyboard.press('Escape'); await fr.locator('body').press('Meta+z'); await saved();
  });
  await check('Anthropic API through the official SDK: key, model, effort and refusal fallback are sent', async () => {
    await openSettings('anthropic');
    await ed.fill('[data-f=baseUrl]', mock.url); await ed.press('[data-f=baseUrl]', 'Tab');
    await ed.fill('[data-f=apiKey]', 'sk-ant-test-key'); await ed.press('[data-f=apiKey]', 'Tab');
    await until(async () => (await ed.textContent('#conn')).includes('2 models'), 5000, 'connected');
    await ed.click('#ai-use');
    mock.answer = `<<<REPLACE_SLIDE id="agenda">>>\n${AGENDA_NEW('Written by Claude via the API')}\n<<<END>>>\n<<<MESSAGE>>>Done via the API.<<<END>>>`;
    await ask('API please');
    assert(section('agenda').includes('Written by Claude via the API'), 'not applied');
    const req = mock.requests.filter(r => r.path.startsWith('/v1/messages')).pop();
    assert(req.headers.authorization === 'Bearer sk-ant-test-key' && req.headers['anthropic-version'], 'key header');
    assert(req.body.model === 'claude-opus-5-5' && req.body.stream === true && req.body.max_tokens === 64000, JSON.stringify(req.body).slice(0, 200));
    assert(req.body.fallbacks === 'default' && String(req.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), 'fallback missing');
    assert(req.body.output_config?.effort === 'medium' && typeof req.body.system === 'string' && req.body.system.includes('<<<REPLACE_SLIDE'), 'effort/system');
    await ed.keyboard.press('Escape'); await fr.locator('body').press('Meta+z'); await saved();
    await openSettings('claude-code'); await ed.click('#ai-use'); // back to the default for anything after this
  });

  if (process.env.REAL_CLAUDE) {
    await check('Claude (real CLI, haiku): changes the selected object', async () => {
      server.kill(); await sleep(300);
      server = spawn(process.execPath, ['tools/server.mjs', '--port', String(PORT)], { cwd: ROOT, env: { ...process.env, DECKELSMOUK_CONFIG: AI_CONFIG }, stdio: 'ignore' });
      await until(() => fetch(`${BASE}/api/decks`).then(r => r.ok), 5000, 'server');
      await gotoSlide(3);
      await clickAt('#numbers .stat');
      await ed.selectOption('#claude-model', 'haiku');
      await ed.fill('#claude-input', 'Give this number the pop entrance effect instead of count.');
      await ed.click('#claude-send');
      await until(async () => !(await ed.isDisabled('#claude-send')), 240000, 'real Claude');
      assert(/<p class="stat[^>]*data-anim="pop"/.test(section('numbers')), section('numbers').slice(0, 400));
    });
  }
  await ectx.close();
} finally {
  await browser?.close();
  server?.kill();
  mock?.close();
  cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (pageErrors.length) { console.log('\nPage errors:'); pageErrors.forEach(e => console.log('  ' + e)); }
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${pageErrors.length ? `, ${pageErrors.length} page errors` : ''}.`);
process.exit(failed.length || pageErrors.length ? 1 : 0);

function require_http() { return http; }

// A stand-in AI server speaking three formats: OpenAI-compatible (LM Studio), Ollama native, and the Anthropic
// Messages API (for the official SDK). It streams mock.answer and records every request.
function startMockAI() {
  const mock = { answer: '', slow: false, requests: [] };
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const p = req.url.split('?')[0];
    mock.requests.push({ path: p, headers: req.headers, body });
    const chunks = mock.answer.match(/[\s\S]{1,40}/g) || [''];
    const pace = () => sleep(mock.slow ? 400 : 2);
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const anthropic = !!req.headers['anthropic-version'];
    if (p === '/v1/models' && anthropic && req.headers.authorization === 'Bearer sk-ant-test-key')
      return json(200, { data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }, { id: 'claude-haiku-5-5', type: 'model', display_name: 'Claude Haiku 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-5-5' });
    if (p.startsWith('/v1/') && !anthropic && req.headers.authorization !== 'Bearer lm-secret-token')
      return json(401, { error: { message: 'An LM Studio API token is required to make requests to this server.' } });
    if (p === '/v1/models') return json(200, { data: [{ id: 'mock-small' }, { id: 'mock-large' }] });
    if (p === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of chunks) { if (res.destroyed) return; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`); await pace(); }
      return res.end('data: [DONE]\n\n');
    }
    if (p === '/api/tags') return json(200, { models: [{ name: 'qwen-mock' }] });
    if (p === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const c of chunks) { if (res.destroyed) return; res.write(JSON.stringify({ message: { role: 'assistant', content: c }, done: false }) + '\n'); await pace(); }
      return res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    }
    if (anthropic && req.headers.authorization !== 'Bearer sk-ant-test-key') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (p === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const c of chunks) { ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } }); await pace(); }
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
      ev('message_stop', {});
      return res.end();
    }
    json(404, { error: 'not found' });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => {
    mock.url = `http://127.0.0.1:${srv.address().port}`;
    mock.close = () => srv.close();
    ok(mock);
  }));
}
