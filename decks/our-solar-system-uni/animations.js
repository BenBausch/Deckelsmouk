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


/* ===== Slide scripts ===== */

