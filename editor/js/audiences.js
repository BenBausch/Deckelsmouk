// Who a deck is for. The editor offers these when a deck is made (and in its Audience button); the dev server
// (tools/bridge.mjs) gives Claude the guidance of the deck's audience with every request.
// A deck stores its choice in deck.html: <meta name="deck-audience" content="peers"> and, for "custom",
// <meta name="deck-audience-description" content="…the user's own words…">.

export const AUDIENCES = [
  {
    key: 'colleagues',
    name: 'Colleagues',
    short: 'Same project or team: room for technical detail.',
    guide: `Colleagues on the same project or team. They know the context and the jargon and want the technical details.
- Keep a short motivation section (why this matters now) unless the user asks to leave it out.
- Go into technical depth: methods, data, parameters, edge cases, open problems, decisions needed. Technical terms need no explanation.
- Dense slides are fine. Figures keep axes, units and error bars; code, equations and diagrams are welcome.
- Typical arc: motivation → status → results → problems → next steps and decisions.
- Animation only where it shows a process or a sequence.`,
  },
  {
    key: 'peers',
    name: 'Field peers',
    short: 'Same field, not your niche: seminar or conference.',
    guide: `Researchers or professionals from the same broad field, but not specialists in this niche (seminar, conference, department talk).
- Start with the motivation: why the problem matters and what is missing (the gap).
- Define niche terms once. One main message per slide, stated in its title.
- Show the evidence that convinces, with simplified figures that highlight what to look at; details go to backup slides.
- Typical arc: problem → gap → approach → key results → takeaways.
- Build the argument step by step with click steps; keep motion purposeful.`,
  },
  {
    key: 'keynote',
    name: 'Product keynote',
    short: 'A big audience: inspire, impress, be remembered.',
    guide: `A large audience at a product launch or keynote. They should be impressed and remember three things.
- Start with the problem people feel, then the reveal.
- One idea per slide, very few words (a headline or one big number). No bullet lists.
- Benefits, not specs; one memorable number per point, shown huge.
- Full-bleed visuals, generous empty space, a dark stage, strong contrast.
- Story arc: the problem → the reveal → what it means for them → a closing surprise.
- Cinematic motion: dramatic reveals, magic moves between slides, counting numbers, slow fades.`,
  },
  {
    key: 'students',
    name: 'Students',
    short: 'A lecture or course: learning the topic for the first time.',
    guide: `Students in a lecture or course, learning the topic for the first time.
- Open with why it matters and the learning goals of the session.
- Build complex ideas step by step (click steps), from intuition to the formal version; use worked examples and analogies.
- Keep one visual vocabulary throughout (the same colour and shape for the same concept).
- Enough text on the slides to revise from later; fuller explanations go into the speaker notes.
- End with a recap and a few check questions.`,
  },
  {
    key: 'public',
    name: 'General public',
    short: 'Outreach: curious people without background knowledge.',
    guide: `The general public at an outreach event (open day, public talk, museum, school visit): curious, without background knowledge.
- Start with why anyone should care: a question, a surprising fact, something from everyday life.
- No jargon; when a technical word is unavoidable, explain it in plain words. Short sentences.
- Stories, analogies and everyday comparisons; show the people behind the work.
- Big images, one simple idea per slide, few numbers, each made tangible.
- Friendly, lively motion that supports the story; end with one memorable takeaway.`,
  },
];

export const CUSTOM = { key: 'custom', name: 'Custom', short: 'Describe your audience in your own words.' };
export const DEFAULT_AUDIENCE = 'peers';
export const audienceByKey = key => AUDIENCES.find(a => a.key === key) || (key === CUSTOM.key ? CUSTOM : null);

const decode = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const encode = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The audience stored in a deck.html: { key, text } or null. */
export function readAudience(html) {
  const meta = name => { const m = new RegExp(`<meta name="${name}" content="([^"]*)"`, 'i').exec(html); return m ? decode(m[1]) : ''; };
  const key = meta('deck-audience');
  if (!audienceByKey(key)) return null;
  return { key, text: key === CUSTOM.key ? meta('deck-audience-description') : '' };
}

/** deck.html with the audience set (or removed, with null). */
export function writeAudience(html, aud) {
  const set = (h, name, content) => {
    const re = new RegExp(`\\n?<meta name="${name}" content="[^"]*">`, 'i');
    h = h.replace(re, '');
    return content ? h.replace(/(<title>[^<]*<\/title>)/i, `$1\n<meta name="${name}" content="${encode(content)}">`) : h;
  };
  const ok = aud && audienceByKey(aud.key) && (aud.key !== CUSTOM.key || String(aud.text || '').trim());
  html = set(html, 'deck-audience-description', ok && aud.key === CUSTOM.key ? String(aud.text).trim() : '');
  return set(html, 'deck-audience', ok ? aud.key : '');
}

/* ── Talk length: <meta name="deck-duration" content="20"> (minutes) ── */

export const LENGTHS = [5, 10, 15, 20, 30, 45, 60];
export const DEFAULT_LENGTH = 20;
export function readDuration(html) {
  const m = /<meta name="deck-duration" content="(\d+)"/i.exec(html);
  return m ? Math.max(1, Math.min(600, +m[1])) : null;
}
export function writeDuration(html, minutes) {
  html = html.replace(/\n?<meta name="deck-duration" content="[^"]*">/i, '');
  const n = Math.round(+minutes);
  return n > 0 ? html.replace(/(<title>[^<]*<\/title>)/i, `$1\n<meta name="deck-duration" content="${Math.min(600, n)}">`) : html;
}
/** About how many slides a talk of this length needs for this audience. */
export const slideCount = (minutes, aud) => Math.max(3, Math.round(minutes * ({ keynote: 1.2, students: 0.8 }[aud?.key] || 1)));

/** A short label for the toolbar and the deck cards. */
export const audienceLabel = aud => (!aud ? '' : aud.key === CUSTOM.key ? (aud.text.length > 28 ? aud.text.slice(0, 27) + '…' : aud.text) : audienceByKey(aud.key).name);

/** What Claude is told about the audience. */
export function audienceGuide(aud) {
  if (!aud) return '';
  if (aud.key === CUSTOM.key) return `The audience of this deck, in the user's words: ${aud.text}\nShape content depth, wording, amount of text, structure and motion for them; keep a short motivation section unless the user says otherwise.`;
  const a = audienceByKey(aud.key);
  return `The audience of this deck: ${a.name}. ${a.guide}`;
}
