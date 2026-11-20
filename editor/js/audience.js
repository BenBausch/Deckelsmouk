// Choosing a deck's audience: the five presets plus a custom description. Used on the start page (inline) and by the
// editor's Audience button (in a dialog).
import { AUDIENCES, CUSTOM, DEFAULT_AUDIENCE } from './audiences.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  };
}

/** The editor's Audience dialog (in-page). Resolves to the new { key, text }, or null when cancelled. */
export function audienceDialog(current) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dialog wide';
    d.innerHTML = `<form><h3>Audience</h3>
      <p>Claude shapes content, wording, amount of text and motion for them in every request. The slides you have stay as they are until you ask (try “Fit to audience”).</p>
      <div class="picker-slot"></div>
      <div class="dialog-btns"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Save</button></div></form>`;
    const picker = audiencePicker(d.querySelector('.picker-slot'), current);
    const done = v => { d.close(); d.remove(); resolve(v); };
    d.querySelector('form').onsubmit = e => { e.preventDefault(); const v = picker.value(); if (v) done(v); };
    d.querySelector('[data-cancel]').onclick = () => done(null);
    d.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    d.addEventListener('mousedown', e => { if (e.target === d) done(null); });
    document.body.append(d);
    d.showModal();
    d.querySelector('.aud.on')?.focus();
  });
}
