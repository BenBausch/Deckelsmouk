// Choosing a deck's audience: the five presets plus a custom description. Used on the start page (inline) and by the
// editor's Audience button (in a dialog).
import { AUDIENCES, CUSTOM, DEFAULT_AUDIENCE, LENGTHS, DEFAULT_LENGTH } from './audiences.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Talk length in minutes: common lengths as chips, or any number. Returns { value() → minutes }. */
export function lengthPicker(root, minutes, onChange = () => {}) {
  let cur = +minutes || DEFAULT_LENGTH;
  root.classList.add('length-picker');
  root.innerHTML = `${LENGTHS.map(n => `<button type="button" class="len" data-min="${n}">${n} min</button>`).join('')}
    <label class="len-other">or <input type="number" min="1" max="600" step="1" inputmode="numeric" aria-label="Minutes"> min</label>`;
  const other = root.querySelector('input');
  const show = () => {
    root.querySelectorAll('.len').forEach(b => b.classList.toggle('on', +b.dataset.min === cur));
    if (!LENGTHS.includes(cur)) other.value = cur; else if (document.activeElement !== other) other.value = '';
  };
  root.querySelectorAll('.len').forEach(b => b.onclick = () => { cur = +b.dataset.min; show(); onChange(cur); });
  other.oninput = () => { const n = Math.round(+other.value); if (n > 0 && n <= 600) { cur = n; show(); onChange(cur); } };
  show();
  return { value: () => cur };
}

/**
 * Renders the choice into `root`. value = { key, text }. onChange(value) runs on every change.
 * Returns { value() → { key, text } or null when the custom description is still empty (and shows that) }.
 */
export function audiencePicker(root, value, onChange = () => {}) {
  let cur = { key: value?.key || DEFAULT_AUDIENCE, text: value?.text || '' };
  root.classList.add('audience-picker');
  root.innerHTML = `<div class="aud-options" role="radiogroup">${[...AUDIENCES, CUSTOM].map(a =>
    `<button type="button" class="aud" role="radio" data-key="${a.key}"><b>${esc(a.name)}</b><span>${esc(a.short)}</span></button>`).join('')}</div>
    <textarea class="aud-text" rows="2" placeholder="Who are they, what do they already know, what should they take away? E.g. pupils aged 12–14 at an open day, curious but no physics yet."></textarea>`;
  const text = root.querySelector('.aud-text');
  text.value = cur.text;
  const show = () => {
    root.querySelectorAll('.aud').forEach(b => { const on = b.dataset.key === cur.key; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    text.hidden = cur.key !== CUSTOM.key;
    text.classList.remove('err');
  };
  root.querySelectorAll('.aud').forEach(b => b.onclick = () => {
    cur = { key: b.dataset.key, text: text.value };
    show();
    if (cur.key === CUSTOM.key) text.focus();
    onChange(cur);
  });
  text.oninput = () => { cur = { ...cur, text: text.value }; text.classList.remove('err'); onChange(cur); };
  show();
  return {
    value() {
      if (cur.key === CUSTOM.key && !text.value.trim()) { text.classList.add('err'); text.focus(); return null; }
      return { key: cur.key, text: cur.key === CUSTOM.key ? text.value.trim() : '' };
    },
    /** The current choice, without checking it. */
    peek: () => ({ ...cur }),
  };
}

/**
 * The editor's Audience dialog (in-page): who the talk is for and how long it is.
 * Resolves to { audience: { key, text }, minutes }, or null when cancelled.
 */
export function audienceDialog({ audience, minutes }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dialog wide';
    d.innerHTML = `<form><h3>Audience and talk length</h3>
      <p>Claude shapes content, wording, amount of text and motion for them in every request. The slides you have stay as they are until you ask (try “Fit to audience”).</p>
      <div class="length-slot"></div>
      <div class="picker-slot"></div>
      <div class="dialog-btns"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Save</button></div></form>`;
    const length = lengthPicker(d.querySelector('.length-slot'), minutes);
    const picker = audiencePicker(d.querySelector('.picker-slot'), audience);
    const done = v => { d.close(); d.remove(); resolve(v); };
    d.querySelector('form').onsubmit = e => { e.preventDefault(); const v = picker.value(); if (v) done({ audience: v, minutes: length.value() }); };
    d.querySelector('[data-cancel]').onclick = () => done(null);
    d.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    d.addEventListener('mousedown', e => { if (e.target === d) done(null); });
    document.body.append(d);
    d.showModal();
    d.querySelector('.aud.on')?.focus();
  });
}
