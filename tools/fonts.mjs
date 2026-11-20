// Reads what a font file is: family, weight (or weight range for variable fonts) and style, from its name, OS/2 and
// fvar tables. Handles .ttf/.otf (sfnt), .woff and .woff2 with Node's zlib and brotli. No dependencies.
import zlib from 'node:zlib';
import path from 'node:path';

export const FONT_FORMATS = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };

// WOFF2 refers to common tables by index.
const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

function tables(buf, want) {
  const sig = buf.toString('latin1', 0, 4), out = new Map();
  if (sig === 'wOFF') {
    for (let i = 0, n = buf.readUInt16BE(12); i < n; i++) {
      const p = 44 + i * 20, tag = buf.toString('latin1', p, p + 4);
      if (!want.includes(tag)) continue;
      const off = buf.readUInt32BE(p + 4), comp = buf.readUInt32BE(p + 8), orig = buf.readUInt32BE(p + 12);
      const data = buf.subarray(off, off + comp);
      out.set(tag, comp < orig ? zlib.inflateSync(data) : data);
    }
    return out;
  }
  if (sig === 'wOF2') {
    if (buf.toString('latin1', 4, 8) === 'ttcf') throw new Error('font collections are not supported');
    let p = 48;
    const base128 = () => { let v = 0; for (let k = 0; k < 5; k++) { const b = buf[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } return v; };
    const dir = [];
    for (let i = 0, n = buf.readUInt16BE(12); i < n; i++) {
      const flags = buf[p++];
      let tag = KNOWN[flags & 0x3f];
      if ((flags & 0x3f) === 63) { tag = buf.toString('latin1', p, p + 4); p += 4; }
      const version = flags >> 6, orig = base128();
      const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
      dir.push({ tag, length: transformed ? base128() : orig });
    }
    const data = zlib.brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)));
    let off = 0;
    for (const t of dir) { if (want.includes(t.tag)) out.set(t.tag, data.subarray(off, off + t.length)); off += t.length; }
    return out;
  }
  if (sig === 'ttcf') throw new Error('font collections (.ttc) are not supported');
  for (let i = 0, n = buf.readUInt16BE(4); i < n; i++) {
    const p = 12 + i * 16, tag = buf.toString('latin1', p, p + 4);
    if (want.includes(tag)) { const off = buf.readUInt32BE(p + 8); out.set(tag, buf.subarray(off, off + buf.readUInt32BE(p + 12))); }
  }
  return out;
}

function names(t) {
  const found = {};
  const count = t.readUInt16BE(2), strings = t.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    const platform = t.readUInt16BE(p), enc = t.readUInt16BE(p + 2), lang = t.readUInt16BE(p + 4), id = t.readUInt16BE(p + 6);
    if (![1, 2, 16, 17].includes(id)) continue;
    const raw = t.subarray(strings + t.readUInt16BE(p + 10), strings + t.readUInt16BE(p + 10) + t.readUInt16BE(p + 8));
    let s;
    if (platform === 3 || platform === 0) { s = ''; for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k)); }
    else if (platform === 1 && enc === 0) s = raw.toString('latin1');
    else continue;
    const score = platform === 3 && lang === 0x409 ? 3 : platform === 3 ? 2 : 1;
    if (s.trim() && (!found[id] || found[id].score < score)) found[id] = { s: s.trim(), score };
  }
  return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.s]));
}

const WEIGHTS = [['thin', 100], ['hairline', 100], ['extralight', 200], ['ultralight', 200], ['light', 300], ['regular', 400], ['book', 400], ['normal', 400], ['medium', 500], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800], ['bold', 700], ['black', 900], ['heavy', 900]];
const weightFromWords = s => { const w = String(s).toLowerCase().replace(/[\s_-]+/g, ''); for (const [k, v] of WEIGHTS) if (w.includes(k)) return v; return 400; };

// When the tables can't be read: "SourceSans3-SemiBoldItalic.ttf" → Source Sans 3, 600, italic.
function fromFileName(file) {
  const stem = path.basename(file, path.extname(file));
  const [fam, ...rest] = stem.split(/[-_]/);
  return {
    family: fam.replace(/([a-z])([A-Z0-9])/g, '$1 $2').trim() || 'Font',
    weight: weightFromWords(rest.join(' ') || 'regular'),
    style: /italic|oblique/i.test(stem) ? 'italic' : 'normal',
  };
}

/** { family, weight (number or "100 900"), style, format } of a font file. */
export function fontInfo(buf, file) {
  const format = FONT_FORMATS[path.extname(file).toLowerCase()];
  if (!format) throw new Error('Fonts must be .woff2, .woff, .ttf or .otf files');
  const sig = buf.length > 12 ? buf.toString('latin1', 0, 4) : '';
  if (!['wOFF', 'wOF2', 'OTTO', 'true', 'typ1', '\0\x01\0\0'].includes(sig)) throw new Error(`${path.basename(file)} is not a font file`);
  try {
    const t = tables(buf, ['name', 'OS/2', 'fvar']);
    const n = t.has('name') ? names(t.get('name')) : {};
    const family = n[16] || n[1];
    if (!family) throw new Error('no family name');
    const sub = n[17] || n[2] || '';
    const os2 = t.get('OS/2');
    let weight = os2 && os2.length > 6 ? os2.readUInt16BE(4) : weightFromWords(sub);
    const italic = (os2 && os2.length > 63 && (os2.readUInt16BE(62) & 1)) || /italic|oblique/i.test(sub);
    const fvar = t.get('fvar');
    if (fvar) { // variable font: its weight range
      const axes = fvar.readUInt16BE(4), count = fvar.readUInt16BE(8), size = fvar.readUInt16BE(10);
      for (let i = 0; i < count; i++) {
        const p = axes + i * size;
        if (fvar.toString('latin1', p, p + 4) === 'wght') weight = `${Math.round(fvar.readInt32BE(p + 4) / 65536)} ${Math.round(fvar.readInt32BE(p + 12) / 65536)}`;
      }
    }
    return { family, weight, style: italic ? 'italic' : 'normal', format };
  } catch {
    return { ...fromFileName(file), format };
  }
}
