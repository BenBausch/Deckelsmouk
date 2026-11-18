// Right-hand inspector: Design (position, type, colour), Animate (effects, steps, order), Slide (title, notes,
// transition) and Code (the HTML of the selection or slide).
import { app, $, $$, commit, currentSlide, setSelection, slides, syncThumbs, cleanHTML, api, isObject } from './app.js';
import { boxOf, prepare, draw, setHover } from './canvas.js';
import { align, distribute } from './ops.js';

let tab = 'design';
const panel = () => $('#panel');
const roots = () => app.selection.filter(el => el.isConnected && !app.selection.some(o => o !== el && o.contains(el)));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = v => Math.round(v * 10) / 10;

export function initInspector() {
  $$('.tabs button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; $$('.tabs button').forEach(x => x.classList.toggle('on', x === b)); render(); }));
  app.on('select', render);
  app.on('slide', render);
  app.on('frame', render);
  app.on('change', () => { if (!panel().contains(document.activeElement)) render(); });
}

export function showTab(name) { $(`.tabs button[data-tab="${name}"]`)?.click(); }

function render() {
  if (!app.doc || !currentSlide()) { panel().innerHTML = ''; return; }
  ({ design, animate, slide: slideTab, code })[tab]();
}

/* ── Theme info from the deck's own stylesheet ── */

function deckRules() {
  const sheet = [...app.doc.styleSheets].find(s => s.ownerNode && s.ownerNode.id === 'deck-style');
  try { return sheet ? [...sheet.cssRules] : []; } catch { return []; }
}
function themeColors() {
  const out = [];
  deckRules().filter(r => r.selectorText === ':root').forEach(r => {
    for (const p of r.style) if (p.startsWith('--')) {
      const v = r.style.getPropertyValue(p).trim();
      if (/^(#|rgb|hsl|oklch|color\()/i.test(v)) out.push({ name: p, value: v });
    }
  });
  return out;
}
function typeClasses() {
  return deckRules()
    .filter(r => r.selectorText && /^\.[a-z][\w-]*$/i.test(r.selectorText) && r.style.fontSize)
    .map(r => ({ name: r.selectorText.slice(1), size: parseFloat(r.style.fontSize) || 0 }))
    .sort((a, b) => b.size - a.size);
}
const effectNames = () => Object.keys((app.win && app.win.Deck && app.win.Deck.effects) || {});

function toHex(c) {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return /^#[0-9a-f]{6}$/i.test(c) ? c : '#000000';
  const [r, g, b] = m[1].split(/[ ,/]+/).map(Number);
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
}
const transparent = c => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);

/* ── Small form helpers ── */

// Binds inputs with data-k to handlers: live on input, recorded on change.
function bind(handlers, label) {
  $$('[data-k]', panel()).forEach(inp => {
    const fn = handlers[inp.dataset.k];
    if (!fn) return;
    const live = inp.type === 'checkbox' || inp.tagName === 'SELECT' ? null : 'input';
    if (live) inp.addEventListener('input', () => { fn(inp.value, inp); draw(); });
    inp.addEventListener('change', () => { fn(inp.type === 'checkbox' ? inp.checked : inp.value, inp); draw(); commit(label); syncThumbs(); });
  });
}
const swatches = (target) => `<div class="swatches">${themeColors().map(c => `<button class="swatch" title="${c.name}" style="background:${c.value}" data-swatch="${target}" data-var="var(${c.name})"></button>`).join('')}
  <button class="swatch" title="None" data-swatch="${target}" data-var="" style="background:linear-gradient(135deg,transparent 45%,#ff5a52 45%,#ff5a52 55%,transparent 55%)"></button></div>`;

/* ── Design ── */

function design() {
  const r = roots();
  if (!r.length) {
    panel().innerHTML = `<div class="empty">Click an object on the slide to select it.<br><br>
      <b>Click</b> selects an object, <b>click again</b> goes inside it, <b>double-click</b> edits text,
      <b>⌥-click</b> picks the exact element, <b>⇧-click</b> adds to the selection, drag on empty space to lasso.
      <br><br>Hold <b>⌥</b> while dragging to turn off snapping, <b>⇧</b> to keep a straight line.</div>`;
    return;
  }
  const el = r[0], cs = app.win.getComputedStyle(el), b = boxOf(el);
  const types = typeClasses();
  const curType = types.find(t => el.classList.contains(t.name));
  const multi = r.length > 1;
  panel().innerHTML = `
    <div class="sec">
      <h4>${multi ? `${r.length} objects` : esc(el.tagName.toLowerCase()) + (el.className ? ' · ' + esc([...el.classList].filter(c => !c.startsWith('is-')).join(' ')) : '')}</h4>
      ${multi ? '' : `<div class="row"><label>Name</label><input data-k="name" value="${esc(el.dataset.el || '')}" placeholder="data-el (for Claude)"></div>`}
      ${multi ? `<div class="btns">
        <button data-a="left">⇤</button><button data-a="center">↔</button><button data-a="right">⇥</button>
        <button data-a="top">⤒</button><button data-a="middle">↕</button><button data-a="bottom">⤓</button>
        <button data-d="h">Dist. H</button><button data-d="v">Dist. V</button></div>`
        : `<div class="btns"><button data-a="left" title="Align to slide">⇤</button><button data-a="center">↔</button><button data-a="right">⇥</button>
        <button data-a="top">⤒</button><button data-a="middle">↕</button><button data-a="bottom">⤓</button></div>`}
    </div>
    ${multi ? '' : `<div class="sec"><h4>Position and size</h4>
      <div class="grid2">
        <div class="field"><span>X</span><input data-k="x" type="number" value="${Math.round(b.x)}"></div>
        <div class="field"><span>Y</span><input data-k="y" type="number" value="${Math.round(b.y)}"></div>
        <div class="field"><span>W</span><input data-k="w" type="number" value="${Math.round(parseFloat(cs.width))}"></div>
        <div class="field"><span>H</span><input data-k="h" type="number" value="${Math.round(parseFloat(cs.height))}" placeholder="auto"></div>
        <div class="field"><span>↻</span><input data-k="rot" type="number" value="${parseFloat(el.style.rotate) || 0}"></div>
        <div class="field"><span>α</span><input data-k="opacity" type="number" min="0" max="100" value="${Math.round(parseFloat(cs.opacity) * 100)}"></div>
      </div>
      <div class="row"><label>Locked</label><input data-k="lock" type="checkbox" ${el.hasAttribute('data-lock') ? 'checked' : ''} style="flex:none;width:auto"><span class="hint" style="margin:0">ignore clicks (⌥-click still selects)</span></div>
    </div>`}
    <div class="sec"><h4>Text</h4>
      ${types.length ? `<div class="row"><label>Style</label><select data-k="type"><option value="">—</option>${types.map(t => `<option ${t === curType ? 'selected' : ''}>${t.name}</option>`).join('')}</select></div>` : ''}
      <div class="grid2">
        <div class="field"><span>pt</span><input data-k="size" type="number" value="${Math.round(parseFloat(cs.fontSize))}"></div>
        <select data-k="weight">${[300, 400, 500, 600, 700, 800, 900].map(w => `<option ${+cs.fontWeight === w ? 'selected' : ''}>${w}</option>`).join('')}</select>
        <div class="field"><span>↕</span><input data-k="lh" type="number" step="0.05" value="${r1(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) || ''}" placeholder="line"></div>
        <div class="field"><span>↔</span><input data-k="ls" type="number" step="0.005" value="${r1((parseFloat(cs.letterSpacing) || 0) / parseFloat(cs.fontSize) * 1000) / 1000}" placeholder="em"></div>
      </div>
      <div class="row"><label>Align</label><div class="seg">${['left', 'center', 'right', 'justify'].map(a => `<button data-align="${a}" class="${cs.textAlign === a || (a === 'left' && cs.textAlign === 'start') ? 'on' : ''}">${{ left: '⯇', center: '≡', right: '⯈', justify: '☰' }[a]}</button>`).join('')}</div></div>
      <div class="row color-row"><label>Colour</label><input type="color" data-k="color" value="${toHex(cs.color)}"><input data-k="colortext" value="${esc(el.style.color || '')}" placeholder="inherited"></div>
      ${swatches('color')}
    </div>
    <div class="sec"><h4>Fill and corners</h4>
      <div class="row color-row"><label>Fill</label><input type="color" data-k="bg" value="${toHex(cs.backgroundColor)}"><input data-k="bgtext" value="${esc(el.style.background || el.style.backgroundColor || '')}" placeholder="${transparent(cs.backgroundColor) ? 'none' : 'from style'}"></div>
      ${swatches('bg')}
      <div class="grid2">
        <div class="field"><span>◜</span><input data-k="radius" type="number" value="${parseFloat(cs.borderTopLeftRadius) || 0}"></div>
        <div class="field"><span>▢</span><input data-k="pad" type="number" value="${parseFloat(cs.paddingTop) || 0}" title="padding"></div>
      </div>
    </div>`;

  const each = fn => r.forEach(fn);
  const pos = (axis, v) => { const s = prepare(el); const now = boxOf(el); if (axis === 'x') el.style.left = Math.round(s.left + (+v - now.x)) + 'px'; else el.style.top = Math.round(s.top + (+v - now.y)) + 'px'; };
  bind({
    name: v => { if (v) el.dataset.el = v.trim().replace(/\s+/g, '-'); else delete el.dataset.el; },
    x: v => pos('x', v), y: v => pos('y', v),
    w: v => { prepare(el); el.style.width = (+v) + 'px'; },
    h: v => { prepare(el); el.style.height = v === '' ? '' : (+v) + 'px'; },
    rot: v => { el.style.rotate = +v ? `${+v}deg` : ''; },
    opacity: v => { el.style.opacity = +v >= 100 ? '' : String(+v / 100); },
    lock: v => { if (v) el.setAttribute('data-lock', ''); else el.removeAttribute('data-lock'); },
    type: v => each(e => { types.forEach(t => e.classList.remove(t.name)); if (v) e.classList.add(v); e.style.fontSize = ''; e.style.fontWeight = ''; e.style.lineHeight = ''; e.style.letterSpacing = ''; }),
    size: v => each(e => { e.style.fontSize = v ? v + 'px' : ''; }),
    weight: v => each(e => { e.style.fontWeight = v; }),
    lh: v => each(e => { e.style.lineHeight = v; }),
    ls: v => each(e => { e.style.letterSpacing = v === '' ? '' : v + 'em'; }),
    color: v => each(e => { e.style.color = v; }),
    colortext: v => each(e => { e.style.color = v; }),
    bg: v => each(e => { e.style.background = v; }),
    bgtext: v => each(e => { e.style.background = v; }),
    radius: v => each(e => { e.style.borderRadius = +v ? v + 'px' : ''; }),
    pad: v => each(e => { e.style.padding = +v ? v + 'px' : ''; }),
  }, 'Format');
  $$('[data-align]', panel()).forEach(btn => btn.onclick = () => { each(e => { e.style.textAlign = btn.dataset.align; }); commit('Align text'); design(); });
  $$('[data-a]', panel()).forEach(btn => btn.onclick = () => align(btn.dataset.a));
  $$('[data-d]', panel()).forEach(btn => btn.onclick = () => distribute(btn.dataset.d));
  $$('[data-swatch]', panel()).forEach(btn => btn.onclick = () => {
    const prop = btn.dataset.swatch === 'color' ? 'color' : 'background';
    each(e => { e.style[prop] = btn.dataset.var; });
    commit('Colour'); syncThumbs(); design();
  });
}

/* ── Animate ── */

const EFFECT_HELP = 'Entrance plays when the element appears: with the slide (step 0) or on a click (step 1, 2 …).';

function animate() {
  const r = roots();
  const s = currentSlide();
  const names = effectNames();
  const opts = (cur, none = 'None') => `<option value="">${none}</option>` + names.map(n => `<option ${n === cur ? 'selected' : ''}>${n}</option>`).join('');
  const list = [...s.querySelectorAll('[data-anim],[data-step],[data-out]')]
    .map(el => ({ el, step: +(el.dataset.step || 0), delay: +(el.dataset.delay || 0) }))
    .sort((a, b) => a.step - b.step || a.delay - b.delay);
  const label = el => esc((el.dataset.el || el.textContent.trim().replace(/\s+/g, ' ') || el.tagName.toLowerCase()).slice(0, 40));
  const script = app.win.Deck.scripts && app.win.Deck.scripts[s.id];
  let html = '';
  if (r.length === 1) {
    const el = r[0], d = el.dataset;
    html += `<div class="sec"><h4>Entrance</h4><p class="hint">${EFFECT_HELP}</p>
      <div class="row"><label>Effect</label><select data-k="anim">${opts(d.anim)}</select></div>
      <div class="grid2">
        <div class="field" title="Click step (0 = with the slide)"><span>#</span><input data-k="step" type="number" min="0" value="${d.step || 0}"></div>
        <div class="field" title="Delay in seconds"><span>⏱</span><input data-k="delay" type="number" min="0" step="0.1" value="${d.delay || ''}" placeholder="delay s"></div>
        <div class="field" title="Duration in seconds"><span>⟷</span><input data-k="dur" type="number" min="0" step="0.1" value="${d.dur || ''}" placeholder="dur s"></div>
        <button data-play="in">▶ Try</button>
      </div></div>
      <div class="sec"><h4>Exit</h4>
      <div class="row"><label>Effect</label><select data-k="out">${opts(d.out)}</select></div>
      <div class="grid2">
        <div class="field" title="Leaves at this click step"><span>#</span><input data-k="outStep" type="number" min="1" value="${d.outStep || ''}" placeholder="step"></div>
        <div class="field" title="Duration in seconds"><span>⟷</span><input data-k="outDur" type="number" min="0" step="0.1" value="${d.outDur || ''}" placeholder="dur s"></div>
      </div></div>
      <div class="sec"><h4>Magic move</h4><p class="hint">Give an element on the next slide the same key and it glides there.</p>
      <div class="row"><label>Key</label><input data-k="magic" value="${esc(d.magic || '')}" placeholder="e.g. logo"></div></div>`;
  } else if (r.length > 1) {
    html += `<div class="sec"><h4>${r.length} objects</h4>
      <div class="row"><label>Effect</label><select data-k="anim-all">${opts('', 'Keep')}</select></div>
      <div class="btns"><button data-seq="clicks">One per click</button><button data-seq="stagger">Stagger together</button><button data-seq="clear">Remove</button></div>
      <p class="hint" style="margin-top:8px">One per click: steps 1, 2, 3 … in reading order. Stagger: same step, 0.15 s apart.</p></div>`;
  }
  html += `<div class="sec"><h4>On this slide</h4>${list.length ? `<div class="anim-list">${list.map(({ el, step }) =>
    `<div class="anim-item ${r.includes(el) ? 'on' : ''}" data-i="${list.findIndex(x => x.el === el)}"><span class="st ${step ? '' : 'zero'}">${step || '·'}</span><span class="nm">${label(el)}</span><span class="ef">${esc(el.dataset.anim || 'fade')}${el.dataset.out ? ' → ' + esc(el.dataset.out) : ''}</span></div>`).join('')}</div>`
    : '<p class="hint">Nothing animated yet. Select objects and pick an effect, or ask Claude.</p>'}
    <div class="btns" style="margin-top:10px"><button data-cmd="preview">▶ Play slide</button></div>
    ${script ? `<p class="hint" style="margin-top:10px">This slide also has a script: <span class="mono">Deck.slide('${esc(s.id)}')</span> in animations.js. <a href="#" data-open-js>Open</a></p>` : ''}
  </div>
  <div class="sec"><h4>Effects available</h4><p class="hint">${names.map(esc).join(' · ')}</p>
    <p class="hint">Add your own with <span class="mono">Deck.effect('name', …)</span> in animations.js, or ask Claude for one.</p></div>`;
  panel().innerHTML = html;

  const el = r[0];
  const set = (key, v) => { if (v === '' || v == null || (key === 'step' && +v === 0)) delete el.dataset[key]; else el.dataset[key] = v; };
  if (r.length === 1) bind({
    anim: v => set('anim', v), step: v => set('step', v), delay: v => set('delay', v), dur: v => set('dur', v),
    out: v => { set('out', v); if (v && !el.dataset.outStep) el.dataset.outStep = String((+el.dataset.step || 0) + 1); if (!v) delete el.dataset.outStep; },
    outStep: v => set('outStep', v), outDur: v => set('outDur', v), magic: v => set('magic', v.trim()),
  }, 'Animation');
  if (r.length > 1) {
    bind({ 'anim-all': v => r.forEach(e => { if (v) e.dataset.anim = v; }) }, 'Animation');
    $$('[data-seq]', panel()).forEach(b => b.onclick = () => {
      const ordered = [...r].sort((a, c) => { const A = boxOf(a), C = boxOf(c); return Math.abs(A.y - C.y) > 40 ? A.y - C.y : A.x - C.x; });
      const base = Math.max(0, ...[...s.querySelectorAll('[data-step]')].filter(e => !r.includes(e)).map(e => +e.dataset.step));
      ordered.forEach((e, i) => {
        if (b.dataset.seq === 'clear') { ['anim', 'step', 'delay', 'dur', 'out', 'outStep'].forEach(k => delete e.dataset[k]); return; }
        if (!e.dataset.anim) e.dataset.anim = 'rise';
        if (b.dataset.seq === 'clicks') { e.dataset.step = String(base + i + 1); delete e.dataset.delay; }
        else { e.dataset.delay = String(r1(i * 0.15)); }
      });
      commit('Sequence'); draw(); animate();
    });
  }
  $$('.anim-item', panel()).forEach(row => {
    const it = list[+row.dataset.i].el;
    row.onclick = () => setSelection([it]);
    row.onmouseenter = () => setHover(it);
    row.onmouseleave = () => setHover(null);
  });
  const play = $('[data-play]', panel());
  if (play) play.onclick = () => {
    const D = app.win.Deck, name = el.dataset.anim || 'fade', spec = D.effects[name];
    if (!spec) return;
    const o = { dur: (+el.dataset.dur || 0) * 1000 || spec.dur || 900, delay: 0, ease: spec.ease || 'cubic-bezier(.16,1,.3,1)', out: false, step: 0, slide: currentSlide() };
    const html0 = el.innerHTML, text0 = el.textContent;
    const res = typeof spec === 'function' ? spec(el, o) : el.animate([{ ...spec.from, offset: 0 }, ...(spec.to ? [spec.to] : [])], { duration: o.dur, easing: o.ease });
    // Effects like "words" rewrite the element while playing; put it back exactly as saved.
    Promise.all([].concat(res || []).map(a => a.finished)).finally(() => { if (el.innerHTML !== html0 && el.textContent === text0) el.innerHTML = html0; draw(); });
  };
  const oj = $('[data-open-js]', panel());
  if (oj) oj.onclick = e => { e.preventDefault(); api.post(`/api/reveal?deck=${app.deck}&file=js`); };
}

/* ── Slide ── */

function slideTab() {
  const s = currentSlide();
  const notes = s.querySelector(':scope > .notes');
  const notesText = notes ? [...notes.querySelectorAll('p')].map(p => p.textContent).join('\n\n') || notes.textContent.trim() : '';
  const bg = s.style.background || s.style.backgroundColor || '';
  panel().innerHTML = `
    <div class="sec"><h4>Slide ${app.index + 1} of ${slides().length}</h4>
      <div class="row"><label>Title</label><input data-k="title" value="${esc(s.dataset.title || '')}"></div>
      <div class="row"><label>ID</label><input data-k="id" value="${esc(s.id)}" title="Used in animations.js: Deck.slide('id')"></div>
      <div class="row"><label>Transition</label><select data-k="transition">${['fade', 'none', 'push', 'zoom'].map(t => `<option ${(s.dataset.transition || 'fade') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="row"><label>Duration</label><input data-k="tdur" type="number" step="0.1" min="0" value="${s.dataset.transitionDur || ''}" placeholder="0.6 s"></div>
      <div class="row color-row"><label>Background</label><input type="color" data-k="bg" value="${toHex(app.win.getComputedStyle(s).backgroundColor)}"><input data-k="bgtext" value="${esc(bg)}" placeholder="theme"></div>
      ${swatches('slidebg')}
      <div class="row"><label>Backup</label><input data-k="backup" type="checkbox" ${s.hasAttribute('data-backup') ? 'checked' : ''} style="flex:none;width:auto"><span class="hint" style="margin:0">after the end (End key skips it)</span></div>
    </div>
    <div class="sec"><h4>Speaker notes</h4>
      <textarea data-k="notes" rows="9" style="width:100%;resize:vertical" placeholder="Shown in the presenter window (P)">${esc(notesText)}</textarea>
      ${notes && notes.querySelector(':not(p)') ? '<p class="hint">These notes contain formatting; editing here keeps paragraphs only.</p>' : ''}
    </div>
    <div class="sec"><h4>Files</h4><div class="btns">
      <button data-open="html">Open deck.html</button><button data-open="js">Open animations.js</button></div>
      <p class="hint" style="margin-top:8px">Opens in VS Code. Changes on disk show up here at once.</p></div>`;
  bind({
    title: v => { s.dataset.title = v; },
    id: v => { const id = v.trim().replace(/[^\w-]+/g, '-'); if (id && !slides().some(o => o !== s && o.id === id)) s.id = id; },
    transition: v => { if (v === 'fade') delete s.dataset.transition; else s.dataset.transition = v; },
    tdur: v => { if (v) s.dataset.transitionDur = v; else delete s.dataset.transitionDur; },
    bg: v => { s.style.background = v; },
    bgtext: v => { s.style.background = v; },
    backup: v => { if (v) s.setAttribute('data-backup', ''); else s.removeAttribute('data-backup'); },
    notes: v => {
      let n = s.querySelector(':scope > .notes');
      if (!n) { n = app.doc.createElement('aside'); n.className = 'notes'; s.append(n); }
      n.replaceChildren(...v.split(/\n\s*\n/).filter(t => t.trim()).map(t => { const p = app.doc.createElement('p'); p.textContent = t.trim(); return p; }));
    },
  }, 'Slide');
  $$('[data-swatch]', panel()).forEach(btn => btn.onclick = () => { s.style.background = btn.dataset.var; commit('Slide background'); syncThumbs(); slideTab(); });
  $$('[data-open]', panel()).forEach(b => b.onclick = () => api.post(`/api/reveal?deck=${app.deck}&file=${b.dataset.open}`));
}

/* ── Code ── */

function code() {
  const r = roots();
  const el = r.length === 1 ? r[0] : currentSlide();
  panel().innerHTML = `<div class="sec"><h4>${r.length === 1 ? 'Selected element' : 'Whole slide'} · HTML</h4>
    <textarea class="code" id="code-text" spellcheck="false">${esc(cleanHTML(el))}</textarea>
    <div class="btns" style="margin-top:8px"><button class="primary" id="code-apply">Apply</button><button id="code-reset">Reset</button></div>
    <p class="hint" style="margin-top:8px">Edits the deck directly. Select one object to edit just that element.</p></div>`;
  $('#code-reset', panel()).onclick = code;
  $('#code-apply', panel()).onclick = () => {
    const t = app.doc.createElement('template');
    t.innerHTML = $('#code-text', panel()).value.trim();
    const next = t.content.firstElementChild;
    if (!next || t.content.children.length !== 1) return alert('Please keep exactly one root element.');
    const wasSlide = el === currentSlide();
    if (wasSlide && !next.classList.contains('slide')) return alert('The slide must stay a <section class="slide">.');
    el.replaceWith(next);
    commit('Edit HTML');
    syncThumbs(true);
    if (wasSlide) { app.win.Deck.show(app.index); setSelection([]); }
    else if (isObject(next)) setSelection([next]);
  };
}
