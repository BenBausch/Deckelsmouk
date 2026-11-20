// Writes a PowerPoint file (.pptx) from slides made of a background, text boxes and pictures (see export.mjs), with
// speaker notes. Sizes are stage pixels: 1 px = 6350 EMU (a 1920 × 1080 stage is a 13.33 × 7.5 in slide), 1 px = 0.5 pt.
import { writeZip } from './ooxml.mjs';

const E = v => Math.round(v * 6350);
const PT = v => Math.round(v * 50); // px → hundredths of a point
const xml = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const CLRMAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
const rels = list => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"/>`).join('')}</Relationships>`;
const xfrm = b => `<a:xfrm><a:off x="${E(b.x)}" y="${E(b.y)}"/><a:ext cx="${Math.max(1, E(b.w))}" cy="${Math.max(1, E(b.h))}"/></a:xfrm>`;
const color = (hex, alpha = 1) => `<a:srgbClr val="${hex}">${alpha < 1 ? `<a:alpha val="${Math.round(alpha * 100000)}"/>` : ''}</a:srgbClr>`;

function run(r) {
  const at = [`lang="en-US"`, `sz="${Math.max(100, Math.min(400000, PT(r.size)))}"`, `b="${r.bold ? 1 : 0}"`, r.italic ? 'i="1"' : '', r.underline ? 'u="sng"' : '', r.spacing ? `spc="${PT(r.spacing)}"` : '', 'dirty="0"'].filter(Boolean).join(' ');
  const font = r.font ? `<a:latin typeface="${xml(r.font)}"/><a:cs typeface="${xml(r.font)}"/>` : '';
  if (r.br) return `<a:br><a:rPr ${at}/></a:br>`;
  return `<a:r><a:rPr ${at}><a:solidFill>${color(r.color, r.alpha)}</a:solidFill>${font}</a:rPr><a:t>${xml(r.text)}</a:t></a:r>`;
}

function paragraph(p) {
  const attrs = [p.align && p.align !== 'l' ? `algn="${p.align}"` : '', p.bullet ? `marL="${E(p.indent || 0)}" indent="${-E(p.indent || 0)}"` : 'marL="0" indent="0"'].filter(Boolean).join(' ');
  let kids = '';
  if (p.lineHeight) kids += `<a:lnSpc><a:spcPts val="${Math.min(158400, PT(p.lineHeight))}"/></a:lnSpc>`;
  kids += `<a:spcBef><a:spcPts val="${Math.min(158400, Math.max(0, PT(p.spaceBefore || 0)))}"/></a:spcBef>`;
  if (p.bullet?.num) kids += '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>';
  else if (p.bullet) kids += `${p.bullet.color ? `<a:buClr>${color(p.bullet.color)}</a:buClr>` : ''}<a:buFont typeface="Arial"/><a:buChar char="${xml(p.bullet.char || '•')}"/>`;
  else kids += '<a:buNone/>';
  const last = p.runs.filter(r => !r.br).at(-1);
  return `<a:p><a:pPr ${attrs}>${kids}</a:pPr>${p.runs.map(run).join('')}<a:endParaRPr lang="en-US" sz="${PT(last?.size || 24)}" dirty="0"/></a:p>`;
}

const textBox = (id, s) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(s.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
  + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${s.anchor || 't'}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${s.paras.map(paragraph).join('')}</p:txBody></p:sp>`;
const picture = (id, rid, s) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xml(s.name || `Picture ${id}`)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
  + `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(s.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;

function themeXml(name, { heading = 'Arial', body = 'Arial', accents = [] } = {}) {
  const acc = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'].map((d, i) => accents[i] || d);
  const font = f => `<a:latin typeface="${xml(f)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const three = s => s + s + s;
  return `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${xml(name)}"><a:themeElements>`
    + `<a:clrScheme name="${xml(name)}"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>`
    + acc.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('') + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
    + `<a:fontScheme name="${xml(name)}"><a:majorFont>${font(heading)}</a:majorFont><a:minorFont>${font(body)}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="${xml(name)}"><a:fillStyleLst>${three('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>')}</a:fillStyleLst>`
    + `<a:lnStyleLst>${three('<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>')}</a:lnStyleLst>`
    + `<a:effectStyleLst>${three('<a:effectStyle><a:effectLst/></a:effectStyle>')}</a:effectStyleLst>`
    + `<a:bgFillStyleLst>${three('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>')}</a:bgFillStyleLst></a:fmtScheme>`
    + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
}

const notesXml = text => `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}`
  + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
  + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>'
  + (String(text || '').split(/\n\s*\n|\n/).map(t => t.trim()).filter(Boolean).map(t => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xml(t)}</a:t></a:r></a:p>`).join('') || '<a:p><a:endParaRPr lang="en-US"/></a:p>')
  + '</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';

const NOTES_MASTER = `${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}`
  + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>'
  + '<p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>'
  + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>'
  + '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
  + '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Notes</a:t></a:r></a:p></p:txBody></p:sp>'
  + `</p:spTree></p:cSld><p:clrMap ${CLRMAP}/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

const MASTER = `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>`
  + `<p:clrMap ${CLRMAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>`
  + '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle>'
  + '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';
const LAYOUT = `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

/**
 * deck = { title, width, height, theme: { heading, body, accents: ['RRGGBB', …] }, slides: [{
 *   background: { color: 'RRGGBB' } | { image: Buffer, ext: 'png'|'jpeg' },
 *   shapes: [{ type: 'picture', box, image, ext, name? } | { type: 'text', box, anchor, paras: [{ align, lineHeight, spaceBefore,
 *     bullet: { char, color } | { num: true } | null, indent, runs: [{ text, font, size, bold, italic, underline, color, alpha, spacing } | { br: true, size }] }] }],
 *   notes }] }
 * → Buffer (.pptx)
 */
export function writePptx(deck) {
  const files = [], media = [];
  const slideIds = deck.slides.map((s, i) => i + 1);
  const ct = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>', '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>', '<Default Extension="jpeg" ContentType="image/jpeg"/>'];
  const over = (part, type) => ct.push(`<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`);
  over('ppt/presentation.xml', 'presentationml.presentation.main+xml');
  over('ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml');
  over('ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml');
  over('ppt/notesMasters/notesMaster1.xml', 'presentationml.notesMaster+xml');
  over('ppt/theme/theme1.xml', 'theme+xml');
  over('ppt/theme/theme2.xml', 'theme+xml');
  over('ppt/presProps.xml', 'presentationml.presProps+xml');
  over('ppt/viewProps.xml', 'presentationml.viewProps+xml');
  over('ppt/tableStyles.xml', 'presentationml.tableStyles+xml');
  over('docProps/app.xml', 'extended-properties+xml');
  ct.push('<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>');

  deck.slides.forEach((s, i) => {
    const n = i + 1, srels = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'notesSlide', `../notesSlides/notesSlide${n}.xml`]];
    const addMedia = (buf, ext) => {
      const file = `image${media.length + 1}.${ext === 'jpg' ? 'jpeg' : ext}`;
      media.push({ name: `ppt/media/${file}`, data: buf });
      const rid = `rId${srels.length + 1}`;
      srels.push([rid, 'image', `../media/${file}`]);
      return rid;
    };
    let bg = '';
    if (s.background?.image) bg = `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${addMedia(s.background.image, s.background.ext)}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
    else if (s.background?.color) bg = `<p:bg><p:bgPr><a:solidFill>${color(s.background.color)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
    let id = 1;
    const shapes = s.shapes.map(sh => (sh.type === 'picture' ? picture(++id, addMedia(sh.image, sh.ext), sh) : textBox(++id, sh))).join('');
    files.push({ name: `ppt/slides/slide${n}.xml`, data: `${HEAD}<p:sld ${NS}><p:cSld>${bg}<p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>` });
    files.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: rels(srels) });
    files.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesXml(s.notes) });
    files.push({ name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, data: rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'], ['rId2', 'slide', `../slides/slide${n}.xml`]]) });
    over(`ppt/slides/slide${n}.xml`, 'presentationml.slide+xml');
    over(`ppt/notesSlides/notesSlide${n}.xml`, 'presentationml.notesSlide+xml');
  });

  const prels = [['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'], ['rId3', 'theme', 'theme/theme1.xml'],
    ['rId4', 'presProps', 'presProps.xml'], ['rId5', 'viewProps', 'viewProps.xml'], ['rId6', 'tableStyles', 'tableStyles.xml'],
    ...slideIds.map(n => [`rId${6 + n}`, 'slide', `slides/slide${n}.xml`])];
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const pres = `${HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>'
    + `<p:sldIdLst>${slideIds.map(n => `<p:sldId id="${255 + n}" r:id="rId${6 + n}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${E(deck.width)}" cy="${E(deck.height)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

  const out = [
    { name: '[Content_Types].xml', data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct.join('')}</Types>` },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]) },
    { name: 'docProps/app.xml', data: `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Deckelsmouk</Application><PresentationFormat>Custom</PresentationFormat><Slides>${deck.slides.length}</Slides><Notes>${deck.slides.length}</Notes></Properties>` },
    { name: 'docProps/core.xml', data: `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(deck.title)}</dc:title><dc:creator>Deckelsmouk</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: 'ppt/presentation.xml', data: pres },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels(prels) },
    { name: 'ppt/presProps.xml', data: `${HEAD}<p:presentationPr ${NS}/>` },
    { name: 'ppt/viewProps.xml', data: `${HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` },
    { name: 'ppt/tableStyles.xml', data: `${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]) },
    { name: 'ppt/notesMasters/notesMaster1.xml', data: NOTES_MASTER },
    { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels([['rId1', 'theme', '../theme/theme2.xml']]) },
    { name: 'ppt/theme/theme1.xml', data: themeXml(deck.title || 'Deckelsmouk', deck.theme) },
    { name: 'ppt/theme/theme2.xml', data: themeXml('Notes', deck.theme) },
    ...files, ...media,
  ];
  return writeZip(out);
}
