// Just enough of ZIP and XML to read Office files (.pptx, .potx). Node 20+, no dependencies.
import zlib from 'node:zlib';

/** Reads a ZIP archive: Map(path → () => Buffer). Throws a readable error for anything that isn't a ZIP. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP-based Office file (it may be password-protected or in the old binary format)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the ZIP directory is damaged');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    files.set(name, () => {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.subarray(start, start + size);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`unsupported compression in ${name}`);
    });
  }
  return files;
}

/* ── XML ── elements as { name, attrs, kids, text }; prefixes are kept as written (p:sp, a:off). */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);

export function parseXML(src) {
  const root = { name: '#root', attrs: {}, kids: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[6] !== undefined) { top.text += decode(m[6]); continue; }
    if (m[5] !== undefined) { top.text += m[5]; continue; }
    if (!m[2]) continue; // comment, processing instruction, doctype
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const el = { name: m[2], attrs: {}, kids: [], text: '' };
    m[3].replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, a, b) => { el.attrs[k] = decode(a ?? b); });
    top.kids.push(el);
    if (!m[4]) stack.push(el);
  }
  return root.kids[0] || null;
}

/** First child with this name (or the first child at all). */
export const kid = (n, name) => (n ? (name ? n.kids.find(k => k.name === name) : n.kids[0]) : undefined);
/** All children with this name. */
export const kids = (n, name) => (n ? n.kids.filter(k => k.name === name) : []);
/** Follows a path of child names: at(sp, 'p:spPr', 'a:xfrm'). */
export const at = (n, ...names) => names.reduce((x, name) => kid(x, name), n);
/** First descendant with this name, depth first. */
export function find(n, name) {
  if (!n) return undefined;
  for (const k of n.kids) {
    if (k.name === name) return k;
    const f = find(k, name);
    if (f) return f;
  }
  return undefined;
}
/** All descendants with this name. */
export function findAll(n, name, out = []) {
  if (n) for (const k of n.kids) { if (k.name === name) out.push(k); findAll(k, name, out); }
  return out;
}
