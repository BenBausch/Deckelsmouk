/* Animations for the Deckelsmouk keynote: paper and watercolour. See CLAUDE.md for the full reference.
 *
 * Effects are named and reusable: data-anim="<name>" (entrance) or data-out="<name>" (exit).
 * Built in: fade rise drop left right zoom pop blur wipe wipe-up reveal words count draw pulse
 * Slide scripts run while their slide is on screen (never in the editor).
 */

/* ===== Effects ===== */

// Bleeds in like ink on wet paper: blurred and pale, then sharp. For headings and washes.
Deck.effect('bleed', {
  from: { opacity: 0, filter: 'blur(24px) saturate(.2)', scale: '1.04' },
  dur: 1700,
  ease: 'cubic-bezier(.2, .7, .2, 1)',
});

// A heading that bleeds in, then its brush stroke (.brushed) paints itself underneath, left to right.
Deck.effect('ink-title', (el, o) => {
  const dur = el.dataset.dur ? o.dur : 1700;
  if (o.out) return el.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(24px)' }], { duration: dur, delay: o.delay, easing: o.ease, fill: 'forwards' });
  const anims = [el.animate([{ opacity: 0, filter: 'blur(24px) saturate(.2)', scale: '1.04', offset: 0 }],
    { duration: dur, delay: o.delay, easing: 'cubic-bezier(.2, .7, .2, 1)', fill: 'backwards' })];
  el.querySelectorAll('.brushed').forEach(u => anims.push(u.animate(
    { clipPath: ['inset(0 100% 0 0)', 'inset(0 0% 0 0)'] },
    { pseudoElement: '::after', duration: 900, delay: o.delay + dur * 0.5, easing: 'cubic-bezier(.6, 0, .3, 1)', fill: 'backwards' })));
  return anims;
});

// A drop of paint landing: grows from a blurred speck, with a little overshoot. For dabs, blooms, the turtle.
Deck.effect('dab', {
  from: { opacity: 0, scale: '.3', filter: 'blur(16px)' },
  dur: 1200,
  ease: 'cubic-bezier(.2, .9, .3, 1.15)',
});

// Settles like a sheet of paper laid on the table (ends at the element's own rotation).
Deck.effect('settle', {
  from: { opacity: 0, translate: '0 -60px', rotate: '-4deg', filter: 'blur(4px)' },
  dur: 1000,
  ease: 'cubic-bezier(.2, .8, .3, 1)',
});

// Gathers to the right and shrinks away. An exit: files packed into one.
Deck.effect('gather', {
  from: { opacity: 0, translate: '420px 0', scale: '.4', filter: 'blur(6px)' },
  dur: 900,
  ease: 'cubic-bezier(.6, 0, .4, 1)',
});

// Paints itself in from left to right with a soft, feathered edge, like a brush stroke.
Deck.effect('brush', {
  from: { maskImage: 'linear-gradient(90deg, #000 40%, transparent 60%)', maskSize: '250% 100%', maskRepeat: 'no-repeat', maskPosition: '100% 0' },
  to: { maskImage: 'linear-gradient(90deg, #000 40%, transparent 60%)', maskSize: '250% 100%', maskRepeat: 'no-repeat', maskPosition: '0% 0' },
  dur: 1400,
  ease: 'cubic-bezier(.45, 0, .3, 1)',
});

// Spreads like a drop on wet paper, as the start page's painting does. For pictures and plain blocks, not for
// .wash/.bloom/.stroke (they are masks already). The drop's shape is the theme's --bloom picture.
Deck.effect('wash-in', (el, o) => {
  const bloom = getComputedStyle(el).getPropertyValue('--bloom').trim() || 'radial-gradient(closest-side, #000 75%, transparent)';
  const m = size => ({ maskImage: bloom, maskSize: size, maskPosition: 'center 60%', maskRepeat: 'no-repeat' });
  if (o.out) return el.animate([{ ...m('240% 240%'), opacity: 1 }, { ...m('8% 20%'), opacity: 0 }],
    { duration: o.dur, delay: o.delay, easing: o.ease, fill: 'forwards' });
  return el.animate([{ ...m('8% 20%'), opacity: 0.3 }, { opacity: 1, offset: 0.25 }, { ...m('240% 240%'), opacity: 1 }],
    { duration: o.dur, delay: o.delay, easing: 'cubic-bezier(.4, .15, .3, 1)', fill: 'backwards' });
});

// Types the element's text letter by letter behind a caret, like a prompt being written. data-dur = typing time.
const typedText = new WeakMap();
Deck.effect('type', (el, o) => {
  if (o.out) return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: o.dur, delay: o.delay, easing: o.ease, fill: 'forwards' });
  if (!typedText.has(el)) typedText.set(el, el.textContent);
  const text = typedText.get(el);
  // Driven by an animation of nothing, so pause (K), skipping and cancelling work like any other effect.
  const a = el.animate([{ '--deck-type': 0 }, { '--deck-type': 1 }], { duration: o.dur, delay: o.delay });
  const tick = () => {
    if (a.playState === 'idle') { el.textContent = text; return; } // cancelled: the full text again
    const t = a.currentTime == null ? 0 : Math.max(0, Math.min(1, (a.currentTime - o.delay) / o.dur));
    el.textContent = text.slice(0, Math.round(t * text.length)) + (t < 1 ? '▍' : '');
    if (a.playState !== 'finished') requestAnimationFrame(tick); else el.textContent = text;
  };
  el.textContent = '▍';
  requestAnimationFrame(tick);
  return a;
});


/* ===== Slide scripts ===== */

// Slide "effects": the last click plays every effect again, all at once.
Deck.slide('effects', {
  steps: 1,
  step(n, ctx) {
    if (n === 1 && ctx.was === 0) {
      ctx.$$('.fx [data-anim]').forEach((el, i) =>
        ctx.play(el, el.dataset.anim, { delay: i * 0.05, dur: +el.dataset.dur * 1000 || undefined }));
    }
    ctx.was = n;
  },
});

// Slide "paint": watercolour drops spread on the paper, pool at their edges and fade; step 1 makes it rain.
Deck.slide('paint', {
  enter(ctx) {
    const c = ctx.$('canvas'), g = c.getContext('2d');
    const W = c.width, H = c.height;
    const PIGMENTS = ['#5f9bd0', '#3f5fae', '#d9a447', '#78a043', '#cf7a66', '#b0682c'];
    const rand = (a, b) => a + Math.random() * (b - a);

    // One drop, painted once into its own small canvas: a dozen thin, wobbly glazes and a darker rim.
    const paintDrop = (r, colour) => {
      const S = Math.ceil(r * 2.7), o = document.createElement('canvas');
      o.width = o.height = S;
      const q = o.getContext('2d'), mid = S / 2;
      const waves = [2, 3, 5, 7].map(k => ({ k, amp: rand(0.03, 0.09) / Math.sqrt(k - 1), phase: rand(0, 6.3) }));
      const outline = (scale, jitter) => {
        const extra = [3, 4, 6].map(k => ({ k, amp: rand(0, jitter), phase: rand(0, 6.3) }));
        q.beginPath();
        for (let i = 0; i <= 72; i++) {
          const a = (i / 72) * Math.PI * 2;
          let f = 1;
          for (const w of waves) f += w.amp * Math.sin(w.k * a + w.phase);
          for (const w of extra) f += w.amp * Math.sin(w.k * a + w.phase);
          const x = mid + Math.cos(a) * r * f * scale, y = mid + Math.sin(a) * r * f * scale;
          i ? q.lineTo(x, y) : q.moveTo(x, y);
        }
        q.closePath();
      };
      q.fillStyle = colour;
      q.globalAlpha = 0.07;
      for (let l = 0; l < 12; l++) { outline(rand(0.86, 1.04), 0.05); q.fill(); }
      q.globalAlpha = 0.22;
      q.strokeStyle = colour;
      q.lineWidth = Math.max(2, r * 0.035);
      q.filter = 'blur(1.5px)';
      outline(0.99, 0.02); q.stroke(); // the pigment pooled at the edge
      return o;
    };

    const drops = [];
    const spawn = born => {
      const r = rand(40, 170), reach = r * 1.35; // how far the drop spreads
      let x, y;
      do { x = rand(60, W - 60); y = rand(60, H - 60); } while (x - reach < 1300 && y - reach < 640); // keep the words clear
      drops.push({ x, y, born, life: rand(7, 11), img: paintDrop(r, PIGMENTS[Math.floor(Math.random() * PIGMENTS.length)]) });
    };
    for (let i = 0; i < 9; i++) spawn(-rand(1, 5)); // a few already on the paper
    let due = 0;
    ctx.rate = 1.4; // drops per second
    ctx.loop((t, dt) => {
      due += dt * ctx.rate;
      for (; due >= 1; due--) spawn(t);
      g.clearRect(0, 0, W, H);
      g.globalCompositeOperation = 'multiply';
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i], age = t - d.born;
        if (age > d.life) { drops.splice(i, 1); continue; }
        const grow = 1 - Math.pow(1 - Math.min(1, age / 2.4), 3); // spreads fast, then slows, like water
        const fade = Math.min(1, (d.life - age) / 2.5);
        const s = d.img.width * (0.2 + 0.8 * grow);
        g.globalAlpha = Math.min(1, age * 4) * fade;
        g.drawImage(d.img, d.x - s / 2, d.y - s / 2, s, s);
      }
    });
  },
  step(n, ctx) { ctx.rate = n >= 1 ? 7 : 1.4; },
});

// Slide "ask": when the LLM companion is done (step 1), play the result: the cards come in one by one, the chart draws itself.
Deck.slide('ask', {
  step(n, ctx) {
    if (n === 1 && ctx.was === 0) {
      ctx.after(3.1, () => {
        ctx.$$('.ask-card').forEach((card, i) => ctx.play(card, 'rise', { delay: i * 0.55 }));
        ctx.play(ctx.$('.ask-card svg path'), 'draw', { delay: 1.5, dur: 1800 });
      });
    }
    ctx.was = n;
  },
});
