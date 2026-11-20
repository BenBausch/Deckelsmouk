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

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** Writes a ZIP archive from [{ name, data }] (in order). Pictures that are compressed already are stored as they are. */
export function writeZip(entries) {
  const parts = [], dir = [];
  let offset = 0;
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const { name, data } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const store = /\.(png|jpe?g|gif|zip|woff2?)$/i.test(name);
    const body = store ? raw : zlib.deflateRawSync(raw);
    const fname = Buffer.from(name, 'utf8'), crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(fname.length, 26); head.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(fname.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(head, fname, body);
    dir.push(cd, fname);
    offset += head.length + fname.length + body.length;
  }
  const size = dir.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...dir, end]);
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
