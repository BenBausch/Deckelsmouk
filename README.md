# Deckelsmouk

**Animated presentations as code: written by hand, arranged by mouse, animated by asking Claude.**

Deckelsmouk is a starter for presentations made of plain HTML and JavaScript. Each deck is one HTML page of slides
plus one file of named animations. A visual editor, close to PowerPoint or Keynote, handles the small, precise edits.
For the big moves you select objects or a slide and tell Claude what to do: *"line these up and bring them in one
per click"*. When you're done, every deck builds into **one self-contained HTML file** that plays offline in any
browser.

```
┌──────────── decks/my-talk/ ────────────┐        npm run build        ┌──── dist/my-talk.html ────┐
│ deck.html       slides + theme         │  ────────────────────────▶  │ one file, everything in it │
│ animations.js   named effects, scripts │                             │ slides · runtime ·         │
│ assets/         images, video, fonts   │                             │ animations at the bottom   │
└────────────────────────────────────────┘                             └────────────────────────────┘
          ▲                    ▲
   visual editor        Claude Code (from the editor's prompt bar, or your terminal)
```

## Quick start

Requires **Node 20+**. To use the prompt bar, install the **[Claude Code](https://claude.com/claude-code) CLI**
(`claude`) and log in. No npm install is needed: there are no dependencies.

```bash
git clone https://github.com/BenBausch/Deckelsmouk.git
cd Deckelsmouk
npm run dev                     # opens the editor at http://localhost:4800
```

Open the **example** deck to see every feature, or create a new deck from the start page (or with
`npm run new -- my-talk "My Talk"`).

## The editor

| | |
|---|---|
| **Slides** (left) | Click to open a slide, drag to reorder. **＋ Slide** offers layouts (title, bullets, image, big number…). |
| **Canvas** (centre) | The real deck, live. Select, drag, resize, snap to edges and centres, lasso, double-click to edit text, drop or paste images and videos. |
| **Inspector** (right) | **Design**: position, size, rotation, type style, colours from the deck's theme. **Animate**: entrance, click step, delay, exit, magic move, and the animation order of the slide. **Slide**: title, transition, background, speaker notes. **Code**: the HTML of the selection. |
| **Prompt bar** (bottom) | Ask Claude about what you selected. It edits the files, you see the result right away, and one **⌘Z** undoes it. |

Every change is saved to `deck.html` immediately. Edits made elsewhere (Claude in a terminal, VS Code, `git checkout`)
show up in the open editor within a second.

### Working with Claude

Select one or more objects (or nothing, to mean the whole slide) and type a request:

- *"Animate these in one per click, the chart last with a draw effect."*
- *"Tidy this slide: align the left edges and balance the whitespace."*
- *"Write a new effect where the logo assembles from four pieces, and use it here."*
- *"Add a slide after this one comparing the three options as cards."*

The editor sends Claude the deck, the current slide, and each selected object's HTML, selector and box in stage
pixels. Claude Code runs on your machine (`claude -p`), may only read and edit files (no shell), and follows the
conventions in [`CLAUDE.md`](CLAUDE.md). Follow-up prompts keep the conversation; **New chat** starts fresh. The model
picker chooses Opus, Sonnet or Haiku; leaving it on the default uses your Claude Code default.

You can also open Claude Code in this folder and work on a deck directly; the editor reloads as files change.

### Shortcuts

| Key | Action |
|---|---|
| Click / click again | select an object / go one level inside it |
| ⌥-click | select the exact element under the pointer |
| ⇧-click, drag on empty space | add to selection, lasso |
| Double-click, Enter | edit text (Esc to finish) |
| Arrows, ⇧ Arrows | nudge 1 px / 10 px (with nothing selected, ↑ ↓ change slides) |
| ⌥-drag, ⇧-drag | move without snapping, move in a straight line |
| ⌘C ⌘X ⌘V ⌘D | copy, cut, paste, duplicate |
| ⌫ | delete selection (in the slide list: delete slide) |
| ⌘Z, ⇧⌘Z | undo, redo, including Claude's changes |
| ⌘K | jump to the prompt bar |
| ⌘Enter | play the current slide (Esc closes) |
| T | new text box |

## Presenting

Open the built `dist/<deck>.html`, or **Present** in the editor.

| Key | Action |
|---|---|
| → Space PageDown Enter, click | next step |
| ← PageUp Backspace | back (shows the previous state instantly) |
| Home / End | first slide / last main slide (backup slides come after End) |
| F | fullscreen |
| P | presenter window: current and next slide, notes, timer |
| K | pause / resume all motion |
| B | black screen |

The URL tracks the position (`#3.1` = slide 3, step 1; `#intro` works too). `?print` lays out every slide in its
final state for **Print → Save as PDF**; `?static` turns off motion for screenshots.

## How a deck is written

`deck.html` is ordinary HTML. The slides sit between two markers, each one labelled:

```html
<!-- ==================== SLIDES ==================== -->

<!-- ===== Slide 2 · agenda ===== -->
<section class="slide" id="agenda" data-title="Agenda">
  <h2 class="h2" data-anim="rise" style="position:absolute;left:140px;top:120px;width:1200px">Three things</h2>
  <ul class="list" style="position:absolute;left:140px;top:330px;width:1100px">
    <li data-anim="left" data-step="1">First</li>
    <li data-anim="left" data-step="2">Second</li>
  </ul>
  <aside class="notes"><p>Speaker notes.</p></aside>
</section>

<!-- ==================== END SLIDES ==================== -->
```

- The stage is 1920 × 1080 and scales to any screen. Top-level objects are absolutely positioned in stage pixels,
  which is what the editor moves.
- The theme (colours, type scale, cards…) lives in `<style id="deck-style">` as CSS variables and classes.

### Animations

Simple builds are attributes:

| Attribute | |
|---|---|
| `data-anim="rise"` | entrance effect |
| `data-step="2"` | appears on the 2nd click (absent: with the slide) |
| `data-delay="0.3"` `data-dur="1.2"` | timing in seconds |
| `data-out="fade"` `data-out-step="3"` | exit |
| `data-magic="logo"` | glides to the element with the same key on the next slide |

Built-in effects: `fade` `rise` `drop` `left` `right` `zoom` `pop` `blur` `wipe` `wipe-up` `reveal` `words` (word by word)
`count` (counts up to the number in the text) `draw` (draws SVG strokes) `pulse`.

Anything else goes in `animations.js` as **named** code:

```js
/* ===== Effects ===== */

// Swings in from below with a slight turn. Use with data-anim="swing".
Deck.effect('swing', { from: { opacity: 0, rotate: '-8deg', translate: '0 60px' }, dur: 1100 });

/* ===== Slide scripts ===== */

// Slide "orbit": particles on a canvas; step 1 speeds them up.
Deck.slide('orbit', {
  enter(ctx) { ctx.loop((t, dt) => { /* draw */ }); },
  step(n, ctx) { /* react to clicks */ },
});
```

Slide scripts get a small context (`ctx.loop`, `ctx.after`, `ctx.play`, `ctx.$`…) that is cleaned up when the slide
is left and paused by **K**. The full reference is in [`CLAUDE.md`](CLAUDE.md), which Claude also reads.

## Commands

```bash
npm run dev                          # editor + live reload (http://localhost:4800); `npm start` without opening a browser
npm run build                        # every deck → dist/<deck>.html  (or: npm run build -- my-talk)
npm run new -- my-talk "My Talk"     # new deck from templates/default
npm run unpack -- talk.html my-talk  # a built single file back into an editable deck
```

Environment: `PORT`, `DECK_CLAUDE_MODEL` (default model for the prompt bar), `DECK_CLAUDE_BIN` (path to `claude`).

## Repository layout

```
decks/<name>/        your presentations (deck.html, animations.js, assets/)
templates/default/   the starting point for new decks; add your own themes as more folders
runtime/             the player shared by all decks (deck.js, deck.css); inlined into every build
editor/              the visual editor (plain ES modules, no build step)
tools/               dev server, build, new, unpack (Node, no dependencies)
dist/                built single-file decks (git-ignored by default)
CLAUDE.md            deck format and animation API, for Claude and for you
```

## Bringing in older presentations

Ask Claude Code in this folder: *"Convert ~/talks/old-pitch/index.html into a deck called old-pitch."* The
conversion steps are in `CLAUDE.md`. A deck built with Deckelsmouk can always be unpacked again with `npm run unpack`.

## Notes and limits

- The editor shows each slide fully built and doesn't run slide scripts (canvas drawings appear when you play the
  slide). Use **Play** (⌘Enter) to see the motion.
- Dragging an element that sits inside a layout (a list item, a flex child) offsets it from its place in that layout;
  dragging a top-level object makes it absolutely positioned.
- The dev server only listens on `127.0.0.1` and refuses cross-site requests, because it can start Claude Code.
- Large videos make large single files; everything is base64-inlined.
