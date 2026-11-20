<p align="center">
  <img src="docs/logo.svg" alt="Deckelsmouk turtle" width="220">
</p>

<h1 align="center">Deckelsmouk</h1>

<p align="center">
  <b>Presentations that move like a keynote, edit like PowerPoint, and do what you tell them.</b><br>
  Arrange by mouse. Animate by asking. Ship one HTML file.
</p>

<p align="center">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-30d158">
  <img alt="Output: one HTML file" src="https://img.shields.io/badge/output-one%20HTML%20file-4c8dff">
  <img alt="Works offline" src="https://img.shields.io/badge/works-offline-9b6bff">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-ffb340">
  <img alt="Made for Claude Code" src="https://img.shields.io/badge/made%20for-Claude%20Code-d97757">
</p>

<p align="center">
  <img src="docs/editor.png" alt="The Deckelsmouk editor: slide list, live canvas with a selected number, animation inspector, and a prompt bar asking Claude to animate the chart" width="900">
</p>

---

## Your slides deserve better than a slide tool

Slide software gives you a timeline of fades and flies. Your browser gives you **everything**: SVG that draws itself,
numbers that count up, canvases full of particles, real typography, real video, real code. What it never gave you
was a way to *work* with it: dragging a box two pixels left meant editing a style attribute and refreshing.

**Deckelsmouk closes that gap.** Your deck is plain HTML and JavaScript you own. On top of it sits a visual editor
you already know how to use, and next to that a prompt bar connected to **Claude Code**. Select three boxes and type
*"bring these in one per click, the chart last, drawing itself"*. A few seconds later it's done, in clean code you
can read, and **⌘Z** takes it back if you don't like it.

When the talk is ready, one command turns it into **a single HTML file**. No app, no account, no internet, no
"which version of Keynote do you have". Email it, put it on a USB stick, open it in ten years.

## Why people switch

<table>
<tr>
<td width="50%" valign="top">

### 🎯 Precise when you want it
Drag, resize and lasso. Smart guides snap to edges and centres. Nudge by the pixel, align, distribute, change
layer order. Double-click to edit text right on the slide. Drop images and videos straight in.

</td>
<td width="50%" valign="top">

### 💬 Effortless when you don't
Select anything and ask. Claude sees exactly what you see: the slide, your selection, every object's position.
It arranges, restyles, writes new animations and adds slides. Its changes appear live and come out as **one undo
step**.

</td>
</tr>
<tr>
<td valign="top">

### ✨ Motion that looks expensive
Word-by-word headlines, counting numbers, self-drawing charts, Keynote-style **magic move**, click-by-click builds,
exits and transitions. When that isn't enough, script anything JavaScript can draw.

</td>
<td valign="top">

### 📦 One file, forever
`npm run build` inlines slides, styles, fonts, images, video and animations into **one self-contained HTML file**
that plays offline in any browser. It can even be unpacked back into an editable deck.

</td>
</tr>
<tr>
<td valign="top">

### 🧑‍💻 Code you can read
No framework magic and no binary format. A deck is `deck.html` (slides, clearly marked) and `animations.js`
(effects with names). Diff it, review it, put it in git, edit it in VS Code. The editor picks up your changes live.

</td>
<td valign="top">

### 🎤 Ready for the stage
Presenter window with current and next slide, notes and a timer. Clicker support, black screen, pause. Print
to PDF for the handout. Backup slides after the end for Q&A.

</td>
</tr>
</table>

## Start in 60 seconds

```bash
git clone https://github.com/BenBausch/Deckelsmouk.git
cd Deckelsmouk
npm run dev
```

That's it, with **no `npm install`**. The editor opens at `http://localhost:4800`. Open the **example** deck for a tour
of every feature, or create your own from the start page.

To use the prompt bar, install the [Claude Code](https://claude.com/claude-code) CLI and log in once. Claude
runs on your machine using your own Claude Code login, with no API key to manage.

## Talk to your slides

Select something, or nothing to mean the whole slide, and just say it:

> *"Animate these in one per click, the chart last with a slow draw."*
> *"Tidy this slide: align the left edges and give it more air."*
> *"Write an effect where the logo assembles from four pieces, and use it here."*
> *"Add a slide after this one comparing the three options as cards."*
> *"Make the number pop, use the accent colour, and pulse it once at the end."*

Under the hood the editor hands Claude Code the deck, the current slide, and every selected object with its HTML,
selector and exact box in stage pixels. Claude follows the house rules in [`CLAUDE.md`](CLAUDE.md), may only read and
edit files (no shell), and you watch each step stream by. Each deck keeps **one running conversation**, even across
restarts of the editor, so follow-ups are quick and keep their context (*"slower"*, *"now the other two too"*).
Pick Opus, Sonnet or Haiku per request.

Tell it **who the deck is for** and every request is shaped for them: *Colleagues* (technical depth), *Field peers*
(seminar or conference), *Product keynote* (big visuals, few words, dramatic reveals), *Students* (step by step, with
a recap) or the *General public* (no jargon, stories), or describe your own audience. Pick it when you create the deck,
change it with the **Audience** button, and let *Fit to audience* rework a slide.

Every deck also has a `session.md`: Claude's notes on what the deck is for, the decisions you made and what you like
or don't. A new conversation starts from it, so Claude never begins from zero, and you can read and edit it like any
other file.

Prefer the terminal? Run `claude` in the repo and work on any deck directly; the open editor updates as files change.

## How it compares

| | PowerPoint / Keynote | HTML frameworks | Hand-written HTML | **Deckelsmouk** |
|---|:---:|:---:|:---:|:---:|
| Visual drag-and-drop editing | ✅ | ❌ | ❌ | ✅ |
| Animation beyond the preset list | ❌ | ⚠️ | ✅ | ✅ |
| Ask an AI to arrange and animate the selection | ⚠️ | ❌ | ❌ | ✅ |
| Your organisation's PowerPoint template, with its layouts | ✅ | ❌ | ❌ | ✅ |
| Readable, diffable source in git | ❌ | ✅ | ✅ | ✅ |
| One portable file, plays offline anywhere | ❌ | ⚠️ | ⚠️ | ✅ |
| Zero install, zero dependencies | ❌ | ❌ | ✅ | ✅ |

## How it works

```
┌──────────── decks/my-talk/ ────────────┐        npm run build        ┌──── dist/my-talk.html ─────┐
│ deck.html       slides + theme         │  ────────────────────────▶  │ one file, everything inside │
│ animations.js   named effects, scripts │                             │ slides · player ·           │
│ assets/         images, video, fonts   │                             │ animations at the bottom    │
└────────────────────────────────────────┘                             └─────────────────────────────┘
          ▲                    ▲
   visual editor      Claude Code (prompt bar or terminal)
```

The source files are the single source of truth. The editor, Claude and your text editor all write to the same files,
and everything stays in sync.

### A slide is just HTML

```html
<!-- ===== Slide 2 · agenda ===== -->
<section class="slide" id="agenda" data-title="Agenda">
  <h2 class="h2" data-anim="rise" style="position:absolute;left:140px;top:120px;width:1200px">Three things</h2>
  <ul class="list" style="position:absolute;left:140px;top:330px;width:1100px">
    <li data-anim="left" data-step="1">First</li>
    <li data-anim="left" data-step="2">Second</li>
  </ul>
  <aside class="notes"><p>Speaker notes.</p></aside>
</section>
```

### Animation is one attribute away

| Attribute | |
|---|---|
| `data-anim="rise"` | entrance effect |
| `data-step="2"` | appears on the 2nd click (absent: with the slide) |
| `data-delay="0.3"` `data-dur="1.2"` | timing in seconds |
| `data-out="fade"` `data-out-step="3"` | exit |
| `data-magic="logo"` | glides to the element with the same key on the next slide |

**Built-in effects:** `fade` `rise` `drop` `left` `right` `zoom` `pop` `blur` `wipe` `wipe-up` `reveal` `words` `count`
`draw` `pulse`.

### Anything more is code with a name

```js
/* ===== Effects ===== */

// Swings in from below with a slight turn. Use it anywhere: data-anim="swing".
Deck.effect('swing', { from: { opacity: 0, rotate: '-8deg', translate: '0 60px' }, dur: 1100 });

/* ===== Slide scripts ===== */

// Slide "orbit": particles on a canvas; the first click speeds them up.
Deck.slide('orbit', {
  enter(ctx) { ctx.loop((t, dt) => { /* draw a frame */ }); },
  step(n, ctx) { /* react to clicks */ },
});
```

Slide scripts get a small, safe context: loops and timers clean up when you leave the slide and freeze when you press
**K**. The full reference is in [`CLAUDE.md`](CLAUDE.md), so humans and Claude follow the same rules.

<details>
<summary><b>Editor shortcuts</b></summary>

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

</details>

<details>
<summary><b>Presenting</b></summary>

Open the built `dist/<deck>.html` in any browser, or click **Present** in the editor.

| Key | Action |
|---|---|
| → Space PageDown Enter, click | next step |
| ← PageUp Backspace | back (shows the previous state instantly) |
| Home / End | first slide / last main slide (backup slides come after End) |
| F | fullscreen |
| P | presenter window: current and next slide, notes, timer |
| K | pause / resume all motion |
| B | black screen |

The URL keeps your place (`#3.1` = slide 3, step 1; `#intro` works too). Add `?print` for every slide in its final
state, ready for **Print → Save as PDF**, or `?static` to turn off motion for screenshots.

</details>

<details>
<summary><b>Commands and settings</b></summary>

```bash
npm run dev                          # editor + live reload (http://localhost:4800); `npm start` without opening a browser
npm run build                        # every deck → dist/<deck>.html  (or: npm run build -- my-talk)
npm run new -- my-talk "My Talk"     # new deck from templates/default (--template <name>, --audience students)
npm run import -- uni.potx "Uni"     # a template from a PowerPoint file, an HTML presentation or a PDF
npm run unpack -- talk.html my-talk  # a built single file back into an editable deck
```

Environment: `PORT`, `DECK_CLAUDE_MODEL` (default model for the prompt bar), `DECK_CLAUDE_BIN` (path to `claude`).

</details>

<details>
<summary><b>Repository layout</b></summary>

```
decks/<name>/        your presentations (deck.html, animations.js, assets/)
archive/<name>/      archived presentations (⋯ → Archive on the start page; ⋯ → Restore brings them back)
templates/<name>/    templates: theme, master and layouts (default, plus your own and imported ones; ⋯ on the
                     start page duplicates or deletes them; with none left, new decks start blank)
runtime/             the player shared by all decks; inlined into every build
editor/              the visual editor (plain ES modules, no build step)
tools/               dev server, build, new, unpack, import (Node, no dependencies)
docs/                logo and screenshots
dist/                built single-file decks (git-ignored by default)
CLAUDE.md            deck format and animation API, for Claude and for you
```

</details>

## Your house style, in one drop

Drop your university's or company's PowerPoint template (`.pptx` or `.potx`) on the start page, and it becomes a
Deckelsmouk template: theme colours and fonts, the slide master's logo, bars and backgrounds, and every slide layout
with its placeholders. New decks start from it, and **＋ Slide** offers its layouts, just like in PowerPoint.

- **From PowerPoint:** converted on your machine in a second, with no upload and no AI needed. If something isn't quite
  like the original, the *Polish import* suggestion asks Claude to compare each layout with the PowerPoint file.
- **From an old HTML presentation (or a .zip of one) or a PDF:** Claude reads it and builds the template in its style.
- **From scratch, or from a deck you like:** *New template* on the start page, or **⋯ → Save design as template** in
  the editor.

Brand fonts travel too: drop `.woff2`, `.woff`, `.ttf` or `.otf` files on a slide (or **⋯ → Fonts…**), pick one for
headings and one for text, and they are inlined into the exported file, so the deck looks the same on every computer.

Decks never change behind your back when a template is updated. To give a deck another template (or the new version
of its own), use **⋯ → Change template…**: the slides stay, the design changes, and ⌘Z takes it back.

A template is simply a deck whose slides are its layouts, so you edit it in the same editor (**⋯ → Edit** on its card).
Things that repeat on every slide, like the logo, live in the theme, behind every slide, where nobody drags them by
accident. Drop a picture on an image placeholder and it fills it.

## Bring your old decks

Have a folder of HTML talks from before? Ask Claude Code in this repo:

> *"Convert ~/talks/old-pitch/index.html into a deck called old-pitch."*

The conversion recipe is in `CLAUDE.md`. From then on, the old deck has an editor too. (To reuse only its *look*,
drop it on the start page instead: that makes a template.)

## Good to know

- **History** (◷ in the toolbar) keeps the last 50 versions of every deck: saved when you open it, every 10 minutes
  while you edit and before each request to Claude. Preview any of them and restore it; restoring can be undone too.
- The editor shows each slide fully built so you can reach every element; press **Play** (⌘Enter) to see the motion.
  Script-driven canvases come alive there.
- Dragging an element out of a layout (a list item, a flex child) offsets it from its place in that layout. Top-level
  objects are positioned freely, like in PowerPoint.
- The dev server listens on `127.0.0.1` only and refuses cross-site requests, since it can start Claude Code.
- Everything is inlined, so long videos make big files. That's the price of a deck that works anywhere.

## Why a turtle?

*Deckelsmouk* is Luxembourgish for **turtle**: a creature that carries its whole home on its back. So does every deck
you build here: one file with everything inside, ready to go wherever you are. Unlike its namesake, it's fast.

## License

Copyright © 2026 Ben Bausch. Free for personal and other noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md): use it, change it, share it, as long as no money is being made with
it. Commercial use needs a separate license; open an issue on
[GitHub](https://github.com/BenBausch/Deckelsmouk) to ask.

<p align="center"><img src="docs/logo.svg" alt="" width="64"></p>
