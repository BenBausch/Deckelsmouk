/* Animations for this deck.
 *
 * Effects are named and reusable: put data-anim="<name>" (entrance) or data-out="<name>" (exit) on any element.
 * Built in: fade rise drop left right zoom pop blur wipe wipe-up reveal words count draw pulse
 *
 *   Deck.effect('name', { from: {…}, to: {…}, dur: 900, ease: '…' })   keyframes from hidden to the element's own style
 *   Deck.effect('name', (el, o) => el.animate(…))                       o = { dur, delay, ease, out, step, slide }
 *
 * Slide scripts run while their slide is on screen (never in the editor):
 *
 *   Deck.slide('slide-id', {
 *     steps: 0,               // extra click steps this script needs (beyond data-step on elements)
 *     enter(ctx) {},          // ctx.$ ctx.$$ ctx.loop(fn(t, dt)) ctx.after(sec, fn) ctx.play(el, 'effect', {delay})
 *     step(n, ctx) {},        // called on entering and on every click step
 *     leave(ctx) {},          // loops, timers and onLeave handlers are cleaned up automatically
 *   });
 */

/* ===== Effects ===== */

// Spin effect for planet images
Deck.effect('spin', { from: { opacity: 0, scale: 0.5, rotate: '-180deg' }, dur: 1200, ease: 'cubic-bezier(.68,-0.55,.265,1.55)' });

// Bounce entrance for planet titles
Deck.effect('bounce', { from: { opacity: 0, scale: 0.8, translate: '0 -40px' }, dur: 900, ease: 'cubic-bezier(.175,.885,.32,1.275)' });

// Glow pulse for highlights
Deck.effect('glow-pulse', (el, o) => el.animate([
  { opacity: 0, filter: 'drop-shadow(0 0 10px rgba(76,141,255,0))' },
  { opacity: 1, filter: 'drop-shadow(0 0 30px rgba(76,141,255,0.6))' }
], { duration: o.dur || 1000, delay: o.delay, fill: 'both' }));

// Pop effect for planets appearing
Deck.effect('orbit-pop', { from: { opacity: 0, scale: 0, filter: 'drop-shadow(0 0 20px rgba(255,255,255,0.8))' }, dur: 800, ease: 'cubic-bezier(.68,-0.55,.265,1.55)' });

/* ===== Slide scripts ===== */

// Solar system map: every planet circles the sun on its own ring.
// r must match the ring sizes in deck.html (ring left/top = 960 - r / 600 - r, size = 2r);
// phase is the starting angle in degrees, speed is turns per second (relative orbital periods, compressed).
Deck.slide('solar-system', {
  enter(ctx) {
    const CX = 960, CY = 600;
    const planets = [
      { el: 'mercury-planet', r: 90,  phase: 20,  speed: 0.128 },
      { el: 'venus-planet',   r: 122, phase: 95,  speed: 0.094 },
      { el: 'earth-planet',   r: 156, phase: 160, speed: 0.080 },
      { el: 'mars-planet',    r: 192, phase: 240, speed: 0.065 },
      { el: 'jupiter-planet', r: 246, phase: 310, speed: 0.035 },
      { el: 'saturn-planet',  r: 292, phase: 45,  speed: 0.026 },
      { el: 'uranus-planet',  r: 336, phase: 130, speed: 0.019 },
      { el: 'neptune-planet', r: 380, phase: 215, speed: 0.014 },
    ].map(p => {
      const el = ctx.$(`[data-el="${p.el}"]`);
      return { ...p, el, w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
    });

    ctx.loop(t => {
      planets.forEach(p => {
        const a = (p.phase + t * p.speed * 360) * Math.PI / 180;
        p.el.style.left = (CX + p.r * Math.cos(a) - p.w / 2) + 'px';
        p.el.style.top = (CY + p.r * Math.sin(a) - p.h / 2) + 'px';
      });
    });
  }
});

