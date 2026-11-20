// Version history of a deck (or template): snapshots of deck.html and animations.js, taken when the deck is opened in
// the editor, every few minutes while it is edited, before every Claude request, and before a restore. The last 50
// are kept per deck in .deckelsmouk/history/<deck>/ (gzipped, machine-local like the Claude conversations).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { ROOT, slidesOf } from './lib.mjs';

const BASE = path.join(ROOT, '.deckelsmouk', 'history');
const KEEP = 50;
const folder = ref => path.join(BASE, String(ref).replace(/[^\w.-]+/g, '__')); // templates/uni → templates__uni
const indexOf = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return []; } };
const validId = id => /^[\w-]+$/.test(id || '');

/** Saves the current state of the deck in `dir` as a version, unless nothing changed since the last one. */
export function snapshot(ref, dir, label) {
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const html = read('deck.html'), js = read('animations.js');
  if (!html) return null;
  const hash = crypto.createHash('sha1').update(html).update('\0').update(js).digest('hex');
  const hdir = folder(ref);
  const index = indexOf(hdir);
  if (index[0]?.hash === hash) return index[0];
  fs.mkdirSync(hdir, { recursive: true });
  let id = String(Date.now());
  while (index.some(e => e.id === id)) id += 'x';
  fs.writeFileSync(path.join(hdir, `${id}.json.gz`), zlib.gzipSync(JSON.stringify({ html, js })));
  const entry = { id, time: Date.now(), label, hash, slides: slidesOf(html).length };
  index.unshift(entry);
  for (const old of index.splice(KEEP)) fs.rmSync(path.join(hdir, `${old.id}.json.gz`), { force: true });
  fs.writeFileSync(path.join(hdir, 'index.json'), JSON.stringify(index, null, 1));
  return entry;
}

/** The versions of a deck, newest first: [{ id, time, label, slides }]. */
export const versions = ref => indexOf(folder(ref)).map(({ hash, ...e }) => e);

/** One version's files: { html, js }. */
export function version(ref, id) {
  if (!validId(id)) throw Object.assign(new Error('Unknown version'), { status: 400 });
  const file = path.join(folder(ref), `${id}.json.gz`);
  if (!fs.existsSync(file)) throw Object.assign(new Error('That version is gone (only the last 50 are kept)'), { status: 404 });
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

/** Forgets a deck's versions (when the deck is deleted). */
export const forgetHistory = ref => fs.rmSync(folder(ref), { recursive: true, force: true });
