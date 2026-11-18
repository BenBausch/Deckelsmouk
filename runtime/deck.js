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
  const MODE = params.has('print') ? 'print' : params.has('edit') ? 'edit' : params.has('presenter') ? 'presenter' : 'present';
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

  /* ── Presenter window ──────────────────────────────────────────────────────
   * The same deck file opened with ?presenter: current slide (at its current step), next slide, speaker notes,
   * timer and controls. It stays in sync with the audience window through postMessage (works for a single file
   * opened from disk) and a BroadcastChannel (works when the editor opened the deck). When the deck is served by the
   * Deckelsmouk dev server, notes are editable here and saved straight into deck.html.
   */

  const CH = 'deckelsmouk:' + location.pathname;
  let bc = null;
  const embedded = window.top !== window; // e.g. the editor's preview: never part of a presentation
  try { if (!embedded) bc = new BroadcastChannel(CH); } catch { /* not available on file:// in some browsers */ }
  let peer = null;                       // the other window, once known
  const seen = new Set();
  function send(msg) {
    if (embedded) return;
    msg = { ...msg, ch: CH, id: Math.random().toString(36).slice(2) };
    const targets = new Set([peer, window.opener].filter(w => w && w !== window && !w.closed));
    targets.forEach(w => { try { w.postMessage(msg, '*'); } catch { /* closed */ } });
    try { if (bc) bc.postMessage(msg); } catch { /* closed */ }
  }
  function listen(handler) {
    const h = (m, src) => {
      if (!m || m.ch !== CH) return;
      if (src && src !== window) peer = src; // even for a duplicate: the BroadcastChannel copy carries no sender
      if (seen.has(m.id)) return;
      seen.add(m.id);
      handler(m);
    };
    addEventListener('message', e => h(e.data, e.source));
    if (bc) bc.onmessage = e => h(e.data, null);
  }
  const baseURL = () => location.href.split('#')[0].split('?')[0];

  function openPresenter() {
    const w = open(baseURL() + '?presenter', 'deck-presenter:' + location.pathname, 'popup,width=1280,height=820');
    if (w) { peer = w; return true; }
    return false;
  }

  // Audience side: report the position; obey the presenter's buttons and keys.
  function tell() {
    if (MODE !== 'present') return;
    send({ type: 'state', slide: cur, step, paused, t0, black: document.body.classList.contains('is-black') });
  }
  function toggleBlack() {
    const on = !document.body.classList.contains('is-black');
    document.body.classList.toggle('is-black', on);
    setPaused(on);
    tell();
  }
  function obey(m) {
    if (m.type === 'hello') return tell();
    if (m.type === 'notes') { const s = slides.find(x => x.id === m.slide); if (s) setNotes(s, m.html); return; }
    if (m.type !== 'cmd') return;
    if (m.cmd === 'next') next();
    if (m.cmd === 'back') back();
    if (m.cmd === 'go') go(m.slide, m.step || 0, { instant: true });
    if (m.cmd === 'pause') setPaused(!paused);
    if (m.cmd === 'black') toggleBlack();
    if (m.cmd === 'reset') { t0 = Date.now(); tell(); }
  }

  function setNotes(s, html) {
    let n = s.querySelector(':scope > .notes');
    if (!n) { n = document.createElement('aside'); n.className = 'notes'; s.append(n); }
    n.innerHTML = html;
  }

  // Presenter side.
  function presenterView() {
    document.body.classList.add('is-presenter', 'is-static');
    document.title = 'Notes · ' + document.title;
    const deckName = (/\/decks\/([^/]+)\/deck\.html$/.exec(location.pathname) || [])[1];
    const css = document.createElement('style');
    css.textContent = `
      html, body { overflow: hidden; background: #111214 !important; }
      body.is-presenter { margin: 0; color: #e8e9ec; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; cursor: default; }
      body.is-presenter > .stage { display: none; }
      .pv { position: fixed; inset: 0; display: grid; grid-template-columns: 1.35fr 1fr; grid-template-rows: auto minmax(0, 1fr) auto; gap: 16px; padding: 16px; box-sizing: border-box; }
      .pv-lbl { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #8a8f98; margin: 0 0 6px; display: flex; justify-content: space-between; gap: 10px; }
      .pv-box { position: relative; overflow: hidden; border-radius: 10px; background: #000; aspect-ratio: ${W()} / ${H()}; box-shadow: 0 0 0 1px #2a2c31; }
      .pv-box > .slide { position: absolute; left: 0; top: 0; width: ${W()}px; height: ${H()}px; visibility: visible !important; transform-origin: 0 0; pointer-events: none; background: var(--bg, #000); color: var(--fg, #fff); }
      .pv-end { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #6b6f78; font-size: 20px; }
      .pv-next-title { color: #a6aab3; margin: 8px 0 0; font-size: 15px; }
      .pv-notes-wrap { grid-column: 1 / 3; display: flex; flex-direction: column; min-height: 0; }
      .pv-notes { flex: 1; overflow: auto; background: #1a1b1e; border-radius: 10px; padding: 14px 20px; font-size: var(--nfs, 26px); line-height: 1.5; outline: none; box-shadow: 0 0 0 1px #2a2c31; }
      .pv-notes:focus { box-shadow: 0 0 0 2px #4c8dff; }
      .pv-notes p { margin: 0 0 .6em; }
      .pv-notes:empty::before { content: attr(data-placeholder); color: #5d616a; }
      .pv-bar { grid-column: 1 / 3; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .pv-time { font-variant-numeric: tabular-nums; font-size: 34px; font-weight: 650; min-width: 110px; }
      .pv-clock { font-variant-numeric: tabular-nums; color: #8a8f98; font-size: 18px; }
      .pv-pos { color: #a6aab3; font-size: 16px; margin-left: 8px; }
      .pv-bar button { font: inherit; font-size: 14px; background: #26282c; color: #e8e9ec; border: 1px solid #34363b; border-radius: 8px; padding: 7px 12px; cursor: pointer; }
      .pv-bar button:hover { background: #303237; }
      .pv-bar button.primary { background: #4c8dff; border-color: #4c8dff; color: #fff; }
      .pv-spacer { flex: 1; }
      .pv-flag { font-weight: 700; color: #ff9f0a; }
      .pv-save { font-size: 12px; color: #8a8f98; }
      .pv-wait { position: fixed; inset: 0; display: flex; flex-direction: column; gap: 14px; align-items: center; justify-content: center; background: rgba(17,18,20,.94); z-index: 5; font-size: 18px; text-align: center; }
      .pv-wait[hidden] { display: none; }
      .pv-wait button { font: inherit; background: #4c8dff; color: #fff; border: 0; border-radius: 10px; padding: 12px 22px; cursor: pointer; }
    `;
    document.head.append(css);
    const ui = document.createElement('div');
    ui.className = 'pv';
    ui.innerHTML = `
      <div><p class="pv-lbl"><span>Now</span><span id="pv-step"></span></p><div class="pv-box" id="pv-now"></div></div>
      <div><p class="pv-lbl"><span>Next</span></p><div class="pv-box" id="pv-next"></div><p class="pv-next-title" id="pv-next-title"></p></div>
      <div class="pv-notes-wrap">
        <p class="pv-lbl"><span>Speaker notes</span><span><span class="pv-save" id="pv-save"></span>
          <button id="pv-smaller" title="Smaller text" style="all:unset;cursor:pointer;padding:0 6px">A−</button><button id="pv-bigger" title="Larger text" style="all:unset;cursor:pointer;padding:0 6px">A+</button></span></p>
        <div class="pv-notes" id="pv-notes" spellcheck="false"></div>
      </div>
      <div class="pv-bar">
        <span class="pv-time" id="pv-time">0:00</span><span class="pv-clock" id="pv-clock"></span>
        <span class="pv-pos" id="pv-pos"></span><span id="pv-flag" class="pv-flag"></span>
        <span class="pv-spacer"></span>
        <button id="pv-reset" title="Restart the timer">Reset timer</button>
        <button id="pv-pause" title="Pause / resume motion (K)">Pause</button>
        <button id="pv-black" title="Black screen (B)">Black</button>
        <button id="pv-back" title="Back (←)">◀ Back</button>
        <button id="pv-next-btn" class="primary" title="Next (→ or Space)">Next ▶</button>
      </div>
      <div class="pv-wait" id="pv-wait" hidden>
        <div>Waiting for the presentation window…</div>
        <button id="pv-open">Open the presentation window</button>
        <div style="color:#8a8f98;font-size:14px">Drag it to the projector and press F for fullscreen. This window keeps your notes.</div>
      </div>`;
    document.body.append(ui);
    const $ = id => document.getElementById(id);
    const notesEl = $('pv-notes');
    let st = { slide: 0, step: 0, paused: false, t0: null, black: false }, connected = false, editing = false;

    // Clone of a slide as it looks at a given step.
    const view = (box, s, n) => {
      box.replaceChildren();
      if (!s) { const e = document.createElement('div'); e.className = 'pv-end'; e.textContent = 'End of presentation'; box.append(e); return; }
      const c = s.cloneNode(true);
      c.classList.add('is-current');
      c.removeAttribute('style');
      c.querySelectorAll('.notes, script').forEach(e => e.remove());
      const orig = animated(s), copy = animated(c);
      orig.forEach((el, k) => { const show = n >= stepIn(el) && n < stepOut(el); copy[k].classList.toggle('is-hidden', !show); });
      c.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
      box.append(c);
      c.style.transform = `scale(${box.clientWidth / W()})`;
    };

    const render = () => {
      const s = slides[st.slide];
      if (!s) return;
      const max = steps(s), last = st.step >= max;
      view($('pv-now'), s, st.step);
      view($('pv-next'), last ? slides[st.slide + 1] : s, last ? 0 : st.step + 1);
      $('pv-next-title').textContent = last ? (slides[st.slide + 1] ? (slides[st.slide + 1].dataset.title || `Slide ${st.slide + 2}`) : '') : `Same slide, click ${st.step + 1} of ${max}`;
      $('pv-step').textContent = max ? `click ${st.step} of ${max}` : '';
      $('pv-pos').textContent = `Slide ${st.slide + 1} of ${slides.length} · ${s.dataset.title || s.id || ''}`;
      $('pv-flag').textContent = st.black ? 'BLACK SCREEN' : st.paused ? 'PAUSED' : '';
      $('pv-pause').textContent = st.paused ? 'Resume' : 'Pause';
      if (!editing) {
        const n = s.querySelector(':scope > .notes');
        const html = n ? n.innerHTML.trim() : '';
        notesEl.innerHTML = /^(<p>\s*<\/p>|\s)*$/.test(html) ? '' : html;
        notesEl.scrollTop = 0;
      }
    };

    // Notes: editable when served by the dev server (saved into deck.html), read-only in a built file.
    let canSave = false, saveTimer = null, savingFor = null;
    const save = async () => {
      const s = slides[savingFor];
      if (!s) return;
      const html = notesEl.innerHTML.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/\son\w+="[^"]*"/gi, '').trim();
      const clean = /^(<br>|\s|<p>\s*<\/p>)*$/.test(html) ? '' : /^<(p|ul|ol|div)\b/.test(html) ? html : `<p>${html}</p>`;
      setNotes(s, clean);
      send({ type: 'notes', slide: s.id, html: clean });
      try {
        const r = await fetch(`/api/notes?deck=${encodeURIComponent(deckName)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Deck': '1' }, body: JSON.stringify({ slide: s.id, html: clean }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        $('pv-save').textContent = 'Saved to deck.html';
      } catch (err) { $('pv-save').textContent = 'Not saved: ' + err.message; }
    };
    if (deckName && location.protocol.startsWith('http')) {
      fetch('/api/decks').then(r => {
        if (!r.ok) return;
        canSave = true;
        notesEl.contentEditable = 'true';
        notesEl.dataset.placeholder = 'Click to add notes for this slide…';
        $('pv-save').textContent = 'Notes are editable';
      }).catch(() => {});
    }
    if (!notesEl.dataset.placeholder) notesEl.dataset.placeholder = 'No notes for this slide.';
    notesEl.addEventListener('focus', () => { if (!canSave) return; editing = true; savingFor = st.slide; document.execCommand('defaultParagraphSeparator', false, 'p'); });
    notesEl.addEventListener('input', () => { $('pv-save').textContent = 'Editing…'; clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); });
    notesEl.addEventListener('blur', () => { if (!canSave) return; clearTimeout(saveTimer); save().then(() => { editing = false; render(); }); });
    notesEl.addEventListener('keydown', e => { if (e.key === 'Escape') notesEl.blur(); });
    notesEl.addEventListener('paste', e => { if (!canSave) return; e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });

    const size = d => { const v = Math.max(14, Math.min(60, (parseFloat(getComputedStyle(notesEl).fontSize) || 26) + d)); notesEl.style.setProperty('--nfs', v + 'px'); try { localStorage.setItem('deck-notes-size', v); } catch { /* ignore */ } };
    try { const v = localStorage.getItem('deck-notes-size'); if (v) notesEl.style.setProperty('--nfs', v + 'px'); } catch { /* ignore */ }
    $('pv-smaller').onclick = () => size(-2);
    $('pv-bigger').onclick = () => size(2);

    const cmd = (c, extra = {}) => send({ type: 'cmd', cmd: c, ...extra });
    $('pv-next-btn').onclick = () => cmd('next');
    $('pv-back').onclick = () => cmd('back');
    $('pv-pause').onclick = () => cmd('pause');
    $('pv-black').onclick = () => cmd('black');
    $('pv-reset').onclick = () => cmd('reset');
    $('pv-open').onclick = () => { const w = open(baseURL() + `#${st.slide + 1}.${st.step}`, 'deck-audience:' + location.pathname); if (w) peer = w; };
    addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('[contenteditable="true"], input, textarea')) return;
      const k = e.key;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) { e.preventDefault(); cmd('next'); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); cmd('back'); }
      else if (k === 'Home') cmd('go', { slide: 0 });
      else if (k === 'End') cmd('go', { slide: lastMain(), step: 99 });
      else if (k === 'k' || k === 'K') cmd('pause');
      else if (k === 'b' || k === 'B' || k === '.') cmd('black');
    });
    addEventListener('resize', render);

    // When the presentation window goes away (closed, or navigated off the deck), this window closes too.
    // A reload of the deck is not an ending: it reconnects within moments and this window stays.
    let lastState = Date.now(), ending = null;
    const deckWin = () => peer || window.opener;
    const end = () => {
      if (Date.now() - lastState < 1500) return; // the deck came back (reload)
      if (editing) { clearTimeout(saveTimer); save(); }
      window.close();
      setTimeout(() => { // a window the user opened by hand cannot be closed by script
        $('pv-wait').hidden = false;
        $('pv-wait').innerHTML = '<div>The presentation has ended.</div><div style="color:#8a8f98;font-size:14px">You can close this window.</div>';
      }, 300);
    };
    const maybeEnd = () => { if (!ending) ending = setTimeout(() => { ending = null; end(); }, 1800); };
    setInterval(() => { const w = deckWin(); if (connected && w && w.closed) maybeEnd(); }, 700);

    listen(m => {
      if (m.type === 'bye') { lastState = 0; maybeEnd(); return; }
      if (m.type === 'notes') { const s = slides.find(x => x.id === m.slide); if (s) { setNotes(s, m.html); if (!editing) render(); } return; }
      if (m.type !== 'state') return;
      connected = true;
      lastState = Date.now(); clearTimeout(ending); ending = null;
      $('pv-wait').hidden = true;
      if (editing && m.slide !== st.slide) { clearTimeout(saveTimer); save(); editing = false; notesEl.blur(); }
      st = m;
      render();
    });
    send({ type: 'hello' });
    setTimeout(() => { if (!connected) $('pv-wait').hidden = false; }, 1200);
    setInterval(() => {
      const sec = st.t0 ? Math.floor((Date.now() - st.t0) / 1000) : 0;
      $('pv-time').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      $('pv-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }, 500);
    render();
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
    else if (k === 'b' || k === 'B' || k === '.') toggleBlack();
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

    if (MODE === 'presenter') { presenterView(); return expose(); }

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
    listen(obey);
    addEventListener('pagehide', () => send({ type: 'bye' }));
    addEventListener('resize', fit);
    fit();
    addEventListener('hashchange', () => { const [i, n] = resolveHash(); if (i !== cur || n !== step) go(i, n, { instant: true }); });
    const [i, n] = resolveHash();
    go(i, n);
    expose();
    // ?notes (used by the editor's Present button): open the notes window right away, or on the first click or key
    // if the browser blocks pop-ups that no click asked for.
    if (params.has('notes') && !openPresenter()) askForNotes();
  }

  function askForNotes() {
    const card = document.createElement('div');
    card.className = 'deck-notes-ask';
    card.innerHTML = '<b>Click or press any key to start</b><span>Your speaker notes open in a separate window. (To skip this, allow pop-ups for this site.)</span>';
    card.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:60;display:flex;flex-direction:column;gap:4px;align-items:center;text-align:center;padding:14px 22px;border-radius:14px;background:rgba(28,29,33,.92);color:#e8e9ec;font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);cursor:pointer';
    card.querySelector('span').style.cssText = 'color:#9a9ca5;font-size:13px';
    document.body.append(card);
    const go = e => {
      if (e.type === 'keydown' && /^(f|F|Shift|Meta|Control|Alt)$/.test(e.key)) return; // fullscreen first is fine
      e.preventDefault(); e.stopImmediatePropagation();
      removeEventListener('keydown', go, true); removeEventListener('pointerdown', go, true);
      if (e.type === 'pointerdown') addEventListener('click', ev => { ev.stopImmediatePropagation(); ev.preventDefault(); }, { capture: true, once: true });
      card.remove();
      openPresenter();
    };
    addEventListener('keydown', go, true);
    addEventListener('pointerdown', go, true);
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
