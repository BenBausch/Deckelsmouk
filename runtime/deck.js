/* Deckelsmouk runtime: plays a deck (a .stage of <section class="slide"> elements).
 *
 * Keys:  → Space PageDown Enter = next step · ← PageUp Backspace = back · Home / End
 *        F fullscreen · P presenter window (notes, next slide, timer) · K pause/resume · B black screen
 * URL:   #<slide>.<step>  (1-based slide number or slide id, e.g. #3.1 or #intro)
 *        ?print   every slide in its final state, one per page (print to PDF)
 *        ?static  no motion (screenshots)
 *        ?edit    used by the visual editor: one slide, final state, no scripts, no navigation
 *        ?thumbs  (with ?edit) used by the editor's slide list
 *
 * Animation model (see CLAUDE.md for the full reference):
 *   Elements:  data-anim="rise" data-step="1" data-delay="0.2" data-dur="0.9"
 *              data-out="fade" data-out-step="3"          (exit)
 *              data-magic="key"                           (glides between slides sharing the key)
 *   Slides:    data-transition="fade|none|push|zoom"  data-title="…"  <aside class="notes">…</aside>
 *   Code:      Deck.effect('name', {from:{…}, to:{…}, ease, dur})  or  Deck.effect('name', (el, o) => el.animate(…))
 *              Deck.slide('slide-id', { steps, enter(ctx), step(n, ctx), leave(ctx) })
 */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const MODE = params.has('print') ? 'print' : params.has('edit') ? 'edit' : 'present';
  const EASE = 'cubic-bezier(.16, 1, .3, 1)';
  const BACK = 'cubic-bezier(.34, 1.56, .64, 1)';

  /* ── Registry ────────────────────────────────────────────────────────────── */

  const effects = Object.create(null);
  const scripts = Object.create(null);

  // A spec is {from, to?, ease?, dur?} (keyframes from a hidden state to the element's own style)
  // or a function (el, o) -> Animation | Animation[] | void. o = {dur, delay, ease, out, step, slide}.
  function effect(name, spec) { effects[name] = spec; return Deck; }
  function slide(id, def) { scripts[id] = def; return Deck; }
  const Deck = window.Deck = { effect, slide, effects, scripts, version: 1 };

  const blur = px => `blur(${px}px)`;
  effect('fade',  { from: { opacity: 0 } });
  effect('rise',  { from: { opacity: 0, translate: '0 40px', filter: blur(12) } });
  effect('drop',  { from: { opacity: 0, translate: '0 -40px', filter: blur(12) } });
  effect('left',  { from: { opacity: 0, translate: '-90px 0', filter: blur(10) } });
  effect('right', { from: { opacity: 0, translate: '90px 0', filter: blur(10) } });
  effect('zoom',  { from: { opacity: 0, scale: '.9', filter: blur(14) } });
  effect('pop',   { from: { opacity: 0, scale: '.5' }, ease: BACK, dur: 700 });
  effect('blur',  { from: { opacity: 0, filter: blur(36) }, dur: 1300 });
  effect('wipe',  { from: { clipPath: 'inset(0 100% 0 0)' }, to: { clipPath: 'inset(0 0% 0 0)' }, ease: 'cubic-bezier(.65,0,.35,1)', dur: 1100 });
  effect('wipe-up', { from: { clipPath: 'inset(100% 0 0 0)' }, to: { clipPath: 'inset(0% 0 0 0)' }, ease: 'cubic-bezier(.65,0,.35,1)', dur: 1100 });
  effect('reveal', { from: { clipPath: 'inset(0 0 100% 0)', translate: '0 30px' }, to: { clipPath: 'inset(0 0 0% 0)', translate: '0 0' } });

  // Headline word by word. Keeps nested markup (colour spans) and <br>.
  const original = new WeakMap();
  effect('words', (el, o) => {
    if (!original.has(el)) original.set(el, el.innerHTML); else el.innerHTML = original.get(el);
    const words = [];
    const walk = node => [...node.childNodes].forEach(n => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(part => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(document.createTextNode(' ')); return; }
          const w = document.createElement('span');
          w.style.display = 'inline-block';
          w.textContent = part;
          words.push(w);
          frag.append(w);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1 && n.tagName !== 'BR' && n.tagName !== 'svg') walk(n);
    });
    walk(el);
    const gap = +(el.dataset.stagger || 75);
    if (o.out) return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: o.dur, delay: o.delay, easing: o.ease, fill: 'forwards' });
    return words.map((w, i) => w.animate(
      [{ opacity: 0, translate: '0 .45em', filter: blur(10) }, { opacity: 1, translate: '0 0', filter: 'none' }],
      { duration: o.dur, delay: o.delay + i * gap, easing: o.ease, fill: 'backwards' }));
  });

  // Number counts up to the value written in the element ("97.4 %", "$1,200"). data-from sets the start.
  effect('count', (el, o) => {
    if (!original.has(el)) original.set(el, el.textContent);
    const text = original.get(el);
    const m = /-?[\d,]*\.?\d+/.exec(text);
    if (!m || o.out) return effects.fade.from && animateSpec(el, effects.fade, o);
    const raw = m[0], to = parseFloat(raw.replace(/,/g, '')), dec = (raw.split('.')[1] || '').length;
    const comma = raw.includes(','), from = parseFloat(el.dataset.from || 0);
    const fmt = v => {
      let s = v.toFixed(dec);
      if (comma) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return text.slice(0, m.index) + s + text.slice(m.index + raw.length);
    };
    el.textContent = fmt(from);
    // Driven by an animation of nothing, so pause/resume and cancel work like any other effect.
    const a = el.animate([{ '--deck-count': 0 }, { '--deck-count': 1 }], { duration: o.dur, delay: o.delay, fill: 'none' });
    const tick = () => {
      if (a.playState === 'idle') { el.textContent = text; return; }
      const t = a.currentTime == null ? 0 : Math.max(0, Math.min(1, (a.currentTime - o.delay) / o.dur));
      el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - t, 4)));
      if (a.playState !== 'finished') requestAnimationFrame(tick); else el.textContent = text;
    };
    requestAnimationFrame(tick);
    return a;
  });

  // SVG strokes draw themselves (paths, lines, circles … inside the element).
  effect('draw', (el, o) => {
    const shapes = el.matches('path,line,polyline,polygon,circle,ellipse,rect') ? [el]
      : [...el.querySelectorAll('path,line,polyline,polygon,circle,ellipse,rect')];
    return shapes.map(s => {
      const len = s.getTotalLength ? s.getTotalLength() : 1000;
      const kf = [{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }];
      return s.animate(o.out ? kf.reverse() : kf, { duration: o.dur, delay: o.delay, easing: o.ease, fill: o.out ? 'forwards' : 'backwards' });
    });
  });

  effect('pulse', (el, o) => el.animate(
    [{ scale: '1' }, { scale: '1.08' }, { scale: '1' }],
    { duration: o.dur, delay: o.delay, easing: 'ease-in-out' }));

  function animateSpec(el, spec, o) {
    const from = { ...spec.from };
    const to = spec.to ? { ...spec.to } : null;
    const kf = o.out ? (to ? [to, from] : [{ ...from, offset: 1 }]) : (to ? [from, to] : [{ ...from, offset: 0 }]);
    return el.animate(kf, { duration: o.dur, delay: o.delay, easing: o.ease, fill: o.out ? 'forwards' : 'backwards' });
  }

  function runEffect(el, name, out, slideEl, step) {
    const spec = effects[name] || effects.fade;
    const ds = el.dataset;
    const dur = +(out ? ds.outDur : ds.dur) * 1000 || spec.dur || 900;
    const delay = +(out ? ds.outDelay : ds.delay) * 1000 || 0;
    const o = { dur, delay, ease: (out ? ds.outEase : ds.ease) || spec.ease || EASE, out, step, slide: slideEl };
    let res = typeof spec === 'function' ? spec(el, o) : animateSpec(el, spec, o);
    res = [].concat(res || []).filter(a => a && typeof a.finished === 'object');
    return res;
  }

  /* ── State ───────────────────────────────────────────────────────────────── */

  let stage, slides = [], cur = -1, step = 0, scale = 1, paused = false, t0 = null;
  const visible = new Map();    // element -> currently shown
  const running = new Map();    // element -> its running effect animations
  let ctx = null;               // context of the current slide's script
  let presenter = null;

  const W = () => +(stage.dataset.width || 1920);
  const H = () => +(stage.dataset.height || 1080);

  const animated = s => [...s.querySelectorAll('[data-anim],[data-step],[data-out]')];
  const stepIn = el => +(el.dataset.step || 0);
  const stepOut = el => (el.dataset.out || el.dataset.outStep) ? +(el.dataset.outStep || 1) : Infinity;
  const steps = s => Math.max(0, +(scripts[s.id] || {}).steps || 0,
    ...animated(s).map(el => Math.max(stepIn(el), isFinite(stepOut(el)) ? stepOut(el) : 0)));
  const lastMain = () => { const i = slides.findIndex(s => s.hasAttribute('data-backup')); return (i < 0 ? slides.length : i) - 1; };

  function fit() {
    if (MODE === 'print' || document.body.classList.contains('is-thumbs')) return;
    scale = Math.min(innerWidth / W(), innerHeight / H());
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  function cancel(el) {
    (running.get(el) || []).forEach(a => a.cancel());
    running.delete(el);
  }

  // Shows the slide's elements as they are at step n. With motion, elements that change play their effect.
  function applyStep(s, n, motion) {
    animated(s).forEach(el => {
      const show = n >= stepIn(el) && n < stepOut(el);
      const was = visible.get(el);
      if (show === was) return;
      visible.set(el, show);
      cancel(el);
      if (show) {
        el.classList.remove('is-hidden');
        if (motion && el.dataset.anim !== 'none') running.set(el, runEffect(el, el.dataset.anim || 'fade', false, s, n));
      } else if (motion && was && el.dataset.out !== 'none') {
        const anims = runEffect(el, el.dataset.out || 'fade', true, s, n);
        running.set(el, anims);
        Promise.all(anims.map(a => a.finished)).then(() => {
          if (visible.get(el) === false) { el.classList.add('is-hidden'); anims.forEach(a => a.cancel()); }
        }, () => {});
        if (!anims.length) el.classList.add('is-hidden');
      } else {
        el.classList.add('is-hidden');
      }
    });
  }

  /* ── Slide scripts ───────────────────────────────────────────────────────── */

  function makeCtx(s) {
    const loops = new Set(), timers = new Set(), cleanups = [];
    const c = {
      slide: s, deck: Deck, step: 0,
      $: sel => s.querySelector(sel),
      $$: sel => [...s.querySelectorAll(sel)],
      get paused() { return paused; },
      // fn(t, dt): t = seconds since the loop started (not counting pauses); return false to stop.
      loop(fn) {
        const L = { fn, t: 0, last: null, id: 0 };
        const tick = now => {
          if (!loops.has(L)) return;
          if (!paused) { if (L.last !== null) L.t += (now - L.last) / 1000; if (fn(L.t, L.last === null ? 0 : (now - L.last) / 1000) === false) { loops.delete(L); return; } }
          L.last = paused ? null : now;
          L.id = requestAnimationFrame(tick);
        };
        loops.add(L);
        L.id = requestAnimationFrame(tick);
        return () => { loops.delete(L); cancelAnimationFrame(L.id); };
      },
      after(sec, fn) { const id = setTimeout(() => { timers.delete(id); fn(); }, sec * 1000); timers.add(id); return id; },
      animate(el, kf, opts) { return (typeof el === 'string' ? s.querySelector(el) : el).animate(kf, opts); },
      play(el, name, opts = {}) {
        el = typeof el === 'string' ? s.querySelector(el) : el;
        const spec = effects[name] || effects.fade;
        const o = { dur: opts.dur ?? spec.dur ?? 900, delay: opts.delay ?? 0, ease: opts.ease || spec.ease || EASE, out: !!opts.out, step: c.step, slide: s };
        el.classList.remove('is-hidden');
        return typeof spec === 'function' ? spec(el, o) : animateSpec(el, spec, o);
      },
      onLeave(fn) { cleanups.push(fn); },
      _stop() {
        loops.forEach(L => cancelAnimationFrame(L.id)); loops.clear();
        timers.forEach(clearTimeout); timers.clear();
        cleanups.splice(0).forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
      },
    };
    return c;
  }

  function call(name, ...args) {
    const def = ctx && scripts[ctx.slide.id];
    if (!def || typeof def[name] !== 'function') return;
    try { def[name](...args); } catch (e) { console.error(`Deck.slide('${ctx.slide.id}').${name}:`, e); }
  }

  /* ── Navigation ──────────────────────────────────────────────────────────── */

  function magic(from, to) {
    const rects = {};
    if (from) from.querySelectorAll('[data-magic]').forEach(el => { rects[el.dataset.magic] = el.getBoundingClientRect(); });
    return () => to.querySelectorAll('[data-magic]').forEach(el => {
      const a = rects[el.dataset.magic];
      if (!a || el.classList.contains('is-hidden')) return;
      const b = el.getBoundingClientRect();
      const dx = (a.left - b.left) / scale, dy = (a.top - b.top) / scale;
      const sx = a.width / b.width || 1, sy = a.height / b.height || 1;
      el.animate([
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: '0 0', transform: 'none' },
      ], { duration: +(el.dataset.magicDur || 1.1) * 1000, easing: EASE });
    });
  }

  function transition(prev, next, back) {
    const kind = next.dataset.transition || 'fade';
    const dur = +(next.dataset.transitionDur || 0.6) * 1000;
    if (prev) {
      prev.classList.add('is-leaving');
      const hasMagic = next.querySelector('[data-magic]');
      prev.querySelectorAll('[data-magic]').forEach(el => { if (hasMagic) el.style.visibility = 'hidden'; });
      const outKf = kind === 'push' ? [{ translate: '0 0' }, { translate: back ? '100% 0' : '-100% 0' }]
        : kind === 'zoom' ? [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '1.08' }]
        : kind === 'none' ? [{ opacity: 0 }, { opacity: 0 }] : [{ opacity: 1 }, { opacity: 0 }];
      const a = prev.animate(outKf, { duration: kind === 'none' ? 1 : dur * .8, easing: EASE, fill: 'forwards' });
      a.finished.then(() => {
        a.cancel(); prev.classList.remove('is-leaving');
        prev.querySelectorAll('[data-magic]').forEach(el => { el.style.visibility = ''; });
        if (!prev.getAttribute('style')) prev.removeAttribute('style');
      }, () => {});
    }
    if (kind === 'none' || !prev) return;
    const inKf = kind === 'push' ? [{ translate: back ? '-100% 0' : '100% 0' }, { translate: '0 0' }]
      : kind === 'zoom' ? [{ opacity: 0, scale: '.94' }, { opacity: 1, scale: '1' }]
      : [{ opacity: 0 }, { opacity: 1 }];
    next.animate(inKf, { duration: dur, easing: EASE });
  }

  function go(i, n = 0, opts = {}) {
    if (paused) setPaused(false); // moving on always resumes
    i = Math.max(0, Math.min(slides.length - 1, i));
    n = Math.max(0, Math.min(steps(slides[i]), n));
    const motion = MODE === 'present' && !document.body.classList.contains('is-static');
    if (i !== cur) {
      const prev = slides[cur], next = slides[i];
      const back = i < cur;
      if (prev) { if (ctx) { call('leave', ctx); ctx._stop(); } prev.querySelectorAll('video').forEach(v => v.pause()); }
      const land = motion ? magic(prev, next) : () => {};
      if (prev) prev.classList.remove('is-current');
      // Entering: everything hidden first, then built up to step n. Going back lands on the final state without motion.
      animated(next).forEach(el => { cancel(el); visible.delete(el); });
      next.classList.add('is-current');
      const animateIn = motion && !opts.instant && !(back && n > 0);
      if (animateIn) {
        animated(next).forEach(el => { visible.set(el, false); el.classList.add('is-hidden'); });
        applyStep(next, 0, true);
        for (let k = 1; k <= n; k++) applyStep(next, k, false);
      } else applyStep(next, n, false);
      if (motion && prev) transition(prev, next, back);
      land();
      cur = i; step = n;
      if (MODE === 'present') {
        next.querySelectorAll('video[autoplay]').forEach(v => { v.currentTime = 0; v.play().catch(() => {}); });
        if (t0 === null && i > 0) t0 = Date.now();
        ctx = makeCtx(next); ctx.step = n;
        call('enter', ctx);
        call('step', n, ctx);
      }
    } else if (n !== step) {
      applyStep(slides[i], n, motion && n > step);
      step = n;
      if (ctx) { ctx.step = n; call('step', n, ctx); }
    }
    if (MODE === 'present') history.replaceState(null, '', `#${cur + 1}.${step}`);
    tell();
    document.dispatchEvent(new CustomEvent('deck:change', { detail: { slide: cur, step } }));
  }

  const next = () => (step < steps(slides[cur]) ? go(cur, step + 1) : cur < slides.length - 1 && go(cur + 1, 0));
  const back = () => (step > 0 ? go(cur, step - 1) : cur > 0 && go(cur - 1, steps(slides[cur - 1])));

  function setPaused(p) {
    if (p === paused) return;
    paused = p;
    document.body.classList.toggle('is-paused', p);
    const s = slides[cur];
    if (s) {
      s.getAnimations({ subtree: true }).forEach(a => (p ? a.pause() : a.play()));
      s.querySelectorAll('video').forEach(v => {
        if (p) { v._deckWasPlaying = !v.paused; v.pause(); } else if (v._deckWasPlaying) v.play().catch(() => {});
      });
    }
    tell();
  }

  /* ── Presenter window (built in, so a single-file deck needs nothing else) ─ */

  const cleanClone = s => {
    const c = s.cloneNode(true);
    c.classList.remove('is-current', 'is-leaving');
    c.querySelectorAll('.is-hidden').forEach(e => e.classList.remove('is-hidden'));
    c.querySelectorAll('.notes, script').forEach(e => e.remove());
    c.removeAttribute('style');
    return c;
  };

  function openPresenter() {
    presenter = open('', 'deck-presenter', 'width=1200,height=760');
    if (!presenter) return;
    const d = presenter.document;
    const css = [...document.querySelectorAll('style, link[rel=stylesheet]')].map(e => e.outerHTML).join('\n');
    d.open();
    d.write(`<!doctype html><html><head><meta charset="utf-8"><title>Presenter · ${document.title}</title>${css}
<style>
  html,body{height:100%;margin:0;overflow:hidden;background:#111;color:#eee;font:16px/1.45 -apple-system,"Helvetica Neue",Arial,sans-serif;cursor:default}
  .pv{display:grid;grid-template-columns:1.25fr 1fr;grid-template-rows:auto 1fr auto;gap:18px;padding:18px;height:100%;box-sizing:border-box}
  .box{position:relative;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:${W()}/${H()}}
  .box .slide{visibility:visible!important;position:absolute;inset:0;width:${W()}px;height:${H()}px;transform-origin:0 0;pointer-events:none;background:var(--bg,#000);color:var(--fg,#fff)}
  .lbl{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#888;margin:0 0 6px}
  .notes{grid-column:1/3;overflow:auto;font-size:22px;line-height:1.5;background:#1b1b1d;border-radius:10px;padding:16px 22px}
  .bar{grid-column:1/3;display:flex;gap:24px;align-items:center;font-size:20px}
  .clock{font-variant-numeric:tabular-nums;font-size:34px;font-weight:600}
  button{font:inherit;background:#2a2a2d;color:#eee;border:0;border-radius:8px;padding:8px 16px;cursor:pointer}
  .paused{color:#ff9f0a;font-weight:700}
</style></head><body><div class="pv">
  <div><p class="lbl">Now · <span id="pos"></span></p><div class="box" id="now"></div></div>
  <div><p class="lbl">Next</p><div class="box" id="next"></div><p id="nexttitle" style="color:#aaa;margin:8px 0 0"></p></div>
  <div class="notes" id="notes"></div>
  <div class="bar"><span class="clock" id="clock">0:00</span><button id="reset">Reset timer</button>
    <button id="prev">◀ Back</button><button id="fwd">Next ▶</button><span id="state"></span></div>
</div></body></html>`);
    d.close();
    const $ = id => d.getElementById(id);
    $('reset').onclick = () => { t0 = Date.now(); tell(); };
    $('prev').onclick = () => back();
    $('fwd').onclick = () => next();
    d.addEventListener('keydown', onKey);
    clearInterval(openPresenter.timer);
    openPresenter.timer = setInterval(() => {
      if (presenter.closed) return clearInterval(openPresenter.timer);
      const sec = t0 ? Math.floor((Date.now() - t0) / 1000) : 0;
      $('clock').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }, 500);
    tell();
  }

  function tell() {
    if (!presenter || presenter.closed) return;
    const d = presenter.document, $ = id => d.getElementById(id);
    if (!$('now')) return;
    const put = (box, s) => {
      box.replaceChildren();
      if (!s) return;
      const c = d.importNode(cleanClone(s), true);
      box.append(c);
      c.style.transform = `scale(${box.clientWidth / W()})`;
    };
    const s = slides[cur];
    put($('now'), s);
    put($('next'), step < steps(s) ? s : slides[cur + 1]);
    $('nexttitle').textContent = step < steps(s) ? `(same slide, step ${step + 1})` : (slides[cur + 1] ? slides[cur + 1].dataset.title || '' : 'End');
    $('pos').textContent = `${cur + 1} / ${slides.length} · ${s.dataset.title || s.id || ''}${steps(s) ? ` · step ${step}/${steps(s)}` : ''}`;
    $('notes').innerHTML = (s.querySelector('.notes') || {}).innerHTML || '<p style="color:#666">No notes.</p>';
    $('state').innerHTML = paused ? '<span class="paused">PAUSED</span>' : '';
  }

  /* ── Input ───────────────────────────────────────────────────────────────── */

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) return;
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) { e.preventDefault(); next(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); back(); }
    else if (k === 'Home') go(0);
    else if (k === 'End') go(lastMain(), 99);
    else if (k === 'f' || k === 'F') (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
    else if (k === 'p' || k === 'P') openPresenter();
    else if (k === 'k' || k === 'K') setPaused(!paused);
    else if (k === 'b' || k === 'B' || k === '.') { const on = !document.body.classList.contains('is-black'); document.body.classList.toggle('is-black', on); setPaused(on); }
  }

  /* ── Start ───────────────────────────────────────────────────────────────── */

  function resolveHash() {
    const m = /^#([^.]+)(?:\.(\d+))?$/.exec(decodeURIComponent(location.hash));
    if (!m) return [0, 0];
    let i = /^\d+$/.test(m[1]) ? +m[1] - 1 : slides.findIndex(s => s.id === m[1]);
    return [Math.max(0, i), m[2] ? +m[2] : 0];
  }

  function init() {
    stage = document.querySelector('.stage');
    if (!stage) return;
    slides = [...stage.querySelectorAll(':scope > .slide')];
    document.documentElement.style.setProperty('--deck-w', W() + 'px');
    document.documentElement.style.setProperty('--deck-h', H() + 'px');
    stage.style.width = W() + 'px';
    stage.style.height = H() + 'px';

    if (MODE === 'print') {
      document.body.classList.add('is-print', 'is-static');
      slides.forEach(s => applyStep(s, steps(s), false));
      return expose();
    }
    if (MODE === 'edit') {
      // The editor owns the DOM: nothing is split, counted, hidden or scripted; only the current slide shows.
      document.body.classList.add('is-editing', 'is-static');
      if (params.has('thumbs')) document.body.classList.add('is-thumbs');
      addEventListener('resize', fit);
      fit();
      const [i] = resolveHash();
      show(i);
      return expose();
    }

    document.body.classList.add('is-presenting');
    if (params.has('static')) document.body.classList.add('is-static');
    const black = document.createElement('div');
    black.className = 'deck-black';
    document.body.append(black);
    addEventListener('keydown', onKey);
    stage.addEventListener('click', e => { if (!e.target.closest('a, button, input, video[controls], [data-no-advance]')) next(); });
    let hide;
    addEventListener('mousemove', () => {
      document.body.classList.add('is-cursor');
      clearTimeout(hide);
      hide = setTimeout(() => document.body.classList.remove('is-cursor'), 1800);
    });
    addEventListener('message', e => { const m = e.data || {}; if (m.deck === 'go') go(m.slide, m.step || 0, { instant: m.instant }); });
    addEventListener('resize', fit);
    fit();
    addEventListener('hashchange', () => { const [i, n] = resolveHash(); if (i !== cur || n !== step) go(i, n, { instant: true }); });
    const [i, n] = resolveHash();
    go(i, n);
    expose();
  }

  // Edit mode: show one slide (all steps visible, nothing hidden).
  function show(i) {
    slides = [...stage.querySelectorAll(':scope > .slide')];
    slides.forEach((s, k) => s.classList.toggle('is-current', k === i));
    cur = i;
  }

  function expose() {
    Object.assign(Deck, { mode: MODE, go, next, back, show, fit, setPaused, steps });
    Object.defineProperties(Deck, {
      slides: { get: () => slides, configurable: true }, current: { get: () => cur, configurable: true },
      step: { get: () => step, configurable: true }, scale: { get: () => scale, configurable: true },
      stage: { get: () => stage, configurable: true }, paused: { get: () => paused, configurable: true },
    });
    document.dispatchEvent(new CustomEvent('deck:ready'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else queueMicrotask(init);
})();
