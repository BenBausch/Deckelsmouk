# Deckelsmouk: working on decks

This repository makes animated HTML presentations. You (Claude) are usually called from the visual editor with a
deck, the current slide, the selected objects and a request. Change the deck so it does what was asked, then say in one or two
sentences what you changed.

## Layout

```
decks/<name>/deck.html       slides + the deck's own styles (theme)
decks/<name>/animations.js   named effects and slide scripts
decks/<name>/assets/         images, video, fonts (referenced as assets/…)
decks/<name>/session.md      Claude's notes on the deck across conversations (purpose, decisions, preferences, log)
runtime/deck.js, deck.css    the player shared by every deck (don't change it for one deck's needs)
templates/<name>/            templates: decks whose slides are layouts (see Templates); source/ = imported original
archive/<name>/              archived decks (moved out of decks/ from the start page; not built; restorable)
tools/blank/                 the built-in blank deck: new decks start from it when there is no template
dist/<name>.html             built single-file deck (npm run build); never edit by hand
```

## deck.html rules

- The stage is **1920 × 1080 px** (`<div class="stage" data-width="1920" data-height="1080">`). All sizes are stage pixels.
- Slides live between the markers `<!-- ==================== SLIDES ==================== -->` and
  `<!-- ==================== END SLIDES ==================== -->`. Each slide is preceded by a marker comment
  `<!-- ===== Slide N · id ===== -->` (the editor renumbers these; keep them when you add slides).
  Nothing but slides and their marker comments goes between the markers. Comments you want to keep go *inside* a section.
- A slide: `<section class="slide" id="unique-id" data-title="Human title">…<aside class="notes"><p>…</p></aside></section>`.
  Optional: `data-transition="fade|none|push|zoom"`, `data-transition-dur="0.6"`, `data-backup` (after the end),
  `data-layout="key"` (the template layout whose design it uses; see Templates).
- `<meta name="deck-audience" content="colleagues|peers|keynote|students|public|custom">` in the head says who the
  deck is for (custom: `<meta name="deck-audience-description" content="…">`). The editor gives you that audience's
  guidance with each request (the presets are in `editor/js/audiences.js`): write and design every change for them.
- A deck made from a template has, after the stage, `<template id="deck-layouts">` with the template's layouts: the
  editor's + Slide menu offers them. It is not shown or exported; leave it alone unless asked to change the layouts.
- **Every top-level object on a slide is absolutely positioned with inline `left`, `top`, `width` (and `height` when it
  matters) in px**, e.g. `style="position:absolute;left:140px;top:120px;width:1200px"`. That is what the editor moves and
  resizes. Inside an object use any layout (flex, grid).
- Give objects you create a short `data-el="name"` so they can be referred to.
- Put visual design in classes in `<style id="deck-style">` (theme tokens on `:root`: `--bg --fg --muted --accent --accent-2 …`).
  Prefer existing classes (`hero h1 h2 h3 lead body small eyebrow stat card pill list glow grad mono muted accent`) and
  `var(--…)` colours over one-off values. Inline style is for position/size and small adjustments.
- CSS animations that should run only while a slide is shown key on `.slide.is-current …`.
- Classes starting with `is-` belong to the runtime; never write them into the file.
- Fonts: system fonts by default; the built file must work offline, so font files go in `assets/fonts/` with
  `@font-face`. The editor's Fonts dialog (⋯ → Fonts…) keeps them, and the heading/text choice (`--font`,
  `--font-heading`), in a marked block at the end of `#deck-style` (`/* ── Fonts ── … */ … /* ── End fonts ── */`);
  keep that block's format if you edit it.
- Assets: `assets/<file>`; everything is inlined at build time.

## Animation (declarative, preferred)

Attributes on any element:

| Attribute | Meaning |
|---|---|
| `data-anim="rise"` | entrance effect (default `fade` if only `data-step` is set) |
| `data-step="1"` | click step on which it appears; `0` or absent = when the slide appears |
| `data-delay="0.3"` `data-dur="0.9"` | seconds |
| `data-out="fade"` `data-out-step="3"` | exit effect and the step on which it leaves (`data-out-dur`) |
| `data-magic="key"` | same key on consecutive slides → the element glides from old to new position/size |
| `data-stagger="75"` | ms between words for `words` |
| `data-from="0"` | start value for `count` |

Built-in effects: `fade rise drop left right zoom pop blur wipe wipe-up reveal words count draw pulse`.
`count` counts up to the number written in the element ("97.4 %"); `draw` draws SVG strokes; `words` reveals word by word.

Going back (←) shows the previous state instantly; only forward steps animate. Elements keep their natural style
as their final state, so the editor and the PDF show slides fully built.

## animations.js (code)

Keep it organised in two sections, `/* ===== Effects ===== */` then `/* ===== Slide scripts ===== */`, with a one-line
comment above each entry.

```js
// A named effect: keyframes from the hidden state to the element's own style (to is optional).
Deck.effect('swing', { from: { opacity: 0, rotate: '-8deg', translate: '0 60px' }, dur: 1100, ease: 'cubic-bezier(.16,1,.3,1)' });

// Or a function returning Web Animations (so pause, skip and cancel work). o = { dur, delay, ease, out, step, slide } (ms).
Deck.effect('typewriter', (el, o) => { … return el.animate(…, { duration: o.dur, delay: o.delay, fill: 'backwards' }); });

// A slide script, for canvas/SVG/JS-driven motion. Runs only in presentation, never in the editor.
Deck.slide('slide-id', {
  steps: 2,                      // extra click steps the script uses (beyond data-step)
  enter(ctx) {                   // ctx.$ / ctx.$$ (scoped to the slide), ctx.loop(fn(t, dt)), ctx.after(sec, fn),
    ctx.loop((t, dt) => { … });  // ctx.play(el, 'effect', {delay, dur}), ctx.animate(el, keyframes, opts), ctx.onLeave(fn)
  },
  step(n, ctx) { … },            // on entering and on every click step
  leave(ctx) { … },              // loops, timers and onLeave handlers stop automatically
});
```

Rules: use Web Animations (`el.animate`) or `ctx.loop` rather than `setInterval`/CSS-class toggling so K (pause) and
navigation stay correct; use transform-like properties `translate`, `scale`, `rotate` (not `transform`) in effects so
they compose with the element's own transform; never create DOM in `deck.html` from a script in a way the editor would
need to save (scripts do not run in the editor); keep effects reusable and named for what they do.

## Templates

A template is a deck in `templates/<name>/` whose slides are its **layouts**, like PowerPoint's slide master and
layouts. A deck made from it copies its theme, `animations.js` and `assets/`, starts with its first layout, and keeps
all layouts in `<template id="deck-layouts">`. The editor opens templates too (`/?template=<name>`).

- **Layouts**: each slide has a unique `id`, `data-layout="key"` (the key its CSS uses) and `data-title` (its name in
  the + Slide menu). Slides made from a layout keep its `data-layout`, so they keep its design. Keep ids and keys
  stable when editing a template; decks made earlier refer to the keys.
- **Theme**: the `:root` tokens and the type classes (`.hero .h1 .h2 .h3 .lead .body .list .small`) in `#deck-style`.
- **Master**: what repeats on every slide (logo, bars, lines, a background picture) is the `background` of `.slide`, as
  CSS background layers, first = topmost, colour last:
  `.slide { background: url("assets/logo.svg") right 80px top 60px / 220px auto no-repeat, linear-gradient(var(--accent), var(--accent)) 0 1040px / 100% 40px no-repeat, var(--bg); }`.
  A layout with its own look gets `.slide[data-layout="key"] { background: …; }` (it may also override tokens such as
  `--bg` and `--fg` for a dark title slide). Imported templates keep the master's layers in `--master` and its colour or
  picture in `--master-bg`, so layouts reuse them: `background: url("assets/layout-x.svg") 0 0 / 100% 100% no-repeat, var(--master), var(--accent);`.
  Never put repeated decorations as elements on every slide: they belong to the master.
- **Placeholders**: short placeholder text in the theme classes. Image areas are `<div class="ph-image" data-el="image">`
  (shown while editing, hidden when presenting; a picture dropped on it takes its place). `<p class="small slide-num">`
  shows the slide number (a CSS counter).
- **Imports**: `npm run import -- <file>` or a file dropped on the editor's start page. PowerPoint files (.pptx, .potx)
  are converted by `tools/pptx.mjs` (report in `source/import-report.md`, the original's theme/master/layout XML in
  `source/pptx/`). HTML, PDF and zipped presentations start as a copy of the default template with the original in
  `source/`; their pictures and fonts are already copied to `assets/`, and Claude restyles the template.
  `source/` is never copied into decks.

## Working on a request from the editor

- The request names the slide (id) and the selected objects (selector + HTML + box). Change those, unless the request
  clearly asks for more.
- For a template (`templates/<name>/`), the slides are layouts: follow Templates above.
- The editor keeps one conversation per deck going across requests, and each request lists the slides with their line
  numbers in deck.html: read only the lines you need.
- `session.md` (in the deck's or template's folder) is the deck's memory across conversations: what it's for, its
  audience, style decisions, the user's preferences and don'ts, notes. The editor puts it into the first prompt of a
  conversation and logs every request under `## Log`. When you learn something worth keeping, add a line to the right
  section; leave the Log alone. Working on a deck from the terminal, read its session.md first.
- Arrange: compute positions in stage px; align edges; keep a margin of at least ~120 px at the sides and ~100 px top/bottom.
- Animate: prefer attributes; write a named effect or slide script only when attributes can't do it.
- Don't reformat or rewrite unrelated slides. Keep text the user wrote unless asked to change it.
- Check your edit keeps valid HTML and that `animations.js` still parses (no syntax errors: one broken script stops all animation).

## Commands

`npm run dev` (editor at http://localhost:4800) · `npm run build [deck]` → `dist/<deck>.html` ·
`npm run new -- <name> ["Title"] [--template <name>] [--audience <preset>|"description"]` · `npm run import -- <file.pptx|.potx|.html|.pdf|.zip> ["Name"]` ·
`npm run unpack -- <file.html> <name>`.

## Converting an older presentation

To bring an existing HTML presentation into this format: create `decks/<name>/` from `templates/default`, move each
slide into a `<section class="slide" id=… data-title=…>` between the markers with absolutely positioned top-level
objects, move its CSS into `#deck-style`, turn its reveal/build logic into `data-anim`/`data-step` attributes, and
port its custom JS animations into named effects or `Deck.slide` scripts in `animations.js`. Copy media into `assets/`.
