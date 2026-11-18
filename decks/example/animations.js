/* Animations for the example deck. See CLAUDE.md for the full reference.
 *
 * Effects are named and reusable: data-anim="<name>" (entrance) or data-out="<name>" (exit).
 * Built in: fade rise drop left right zoom pop blur wipe wipe-up reveal words count draw pulse
 * Slide scripts run while their slide is on screen (never in the editor).
 */

/* ===== Effects ===== */

// Swings in from below with a slight turn.
Deck.effect('orbit-in', {
  from: { opacity: 0, translate: '0 120px', rotate: '-6deg', filter: 'blur(8px)' },
  dur: 1200,
});


/* ===== Slide scripts ===== */

// Slide "orbit": dots circling on the canvas; step 1 speeds them up.
Deck.slide('orbit', {
  steps: 0,
  enter(ctx) {
    const c = ctx.$('canvas'), g = c.getContext('2d');
    const dots = Array.from({ length: 140 }, (_, i) => ({ r: 120 + (i % 14) * 34, a: i * 2.4, s: 0.15 + (i % 7) * 0.04 }));
    ctx.speed = 1;
    ctx.loop((t, dt) => {
      g.clearRect(0, 0, c.width, c.height);
      for (const d of dots) {
        d.a += d.s * dt * ctx.speed;
        const x = 1380 + Math.cos(d.a) * d.r, y = 560 + Math.sin(d.a) * d.r * 0.62;
        g.fillStyle = `rgba(76,141,255,${0.25 + 0.6 * (d.r % 3) / 3})`;
        g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
      }
    });
  },
  step(n, ctx) { ctx.speed = n >= 1 ? 4 : 1; },
});
