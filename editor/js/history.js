// The History panel: earlier versions of the deck (saved when it is opened, every 10 minutes while editing and before
// every Claude request), with a preview of their slides and Restore. Restoring is itself undoable (⌘Z) and saves the
// current state as a version first.
import { app, api, deckQuery, flush, replaceDeck, toast } from './app.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function when(t) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= day) return `Today ${time}`;
  if (t >= day - 864e5) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} ${time}`;
}

/** Saves a version now (the server skips it when nothing changed). */
export const saveVersion = label => api.post(`/api/history/snapshot?${deckQuery()}&label=${encodeURIComponent(label)}`).catch(() => {});

export async function openHistory() {
  await flush();
  let list;
  try { list = await api.get(`/api/history?${deckQuery()}`); } catch (e) { return toast(esc(e.message)); }
  const d = document.createElement('dialog');
  d.className = 'dialog wide history';
  d.innerHTML = `<form><h3>History</h3>
    <p>A version is saved when you open the deck, every 10 minutes while you edit, and before each request to Claude. The last 50 are kept.</p>
    <div class="history-body">
      <div class="history-list" role="listbox"></div>
      <div class="history-preview"><iframe title="Preview" tabindex="-1"></iframe><div class="history-empty"></div></div>
    </div>
    <div class="dialog-btns"><button type="button" data-cancel>Close</button><button type="submit" class="primary" disabled>Restore this version</button></div></form>`;
  const listEl = d.querySelector('.history-list'), frame = d.querySelector('iframe'), restore = d.querySelector('[type=submit]');
  const empty = d.querySelector('.history-empty');
  let picked = null;
  const pick = (v, row) => {
    picked = v;
    listEl.querySelectorAll('.history-row').forEach(r => r.classList.toggle('on', r === row));
    const w = frame.parentElement.clientWidth - 40;
    frame.hidden = false; empty.hidden = true;
    frame.src = `/api/history/view?${deckQuery()}&id=${encodeURIComponent(v.id)}&zoom=${(w / 1920).toFixed(4)}&edit&thumbs`;
    restore.disabled = false;
  };
  if (!list.length) {
    listEl.innerHTML = '<p class="hint" style="padding:10px">No earlier versions yet.</p>';
    frame.hidden = true; empty.hidden = false; empty.textContent = 'Versions appear here as you work.';
  }
  list.forEach((v, i) => {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'history-row'; row.setAttribute('role', 'option');
    row.innerHTML = `<b>${esc(when(v.time))}${i === 0 ? ' <span class="pill-mini">latest</span>' : ''}</b><span>${esc(v.label)}</span><span class="muted">${v.slides} slide${v.slides === 1 ? '' : 's'}</span>`;
    row.onclick = () => pick(v, row);
    listEl.append(row);
  });
  const done = () => { d.close(); d.remove(); };
  d.querySelector('[data-cancel]').onclick = done;
  d.addEventListener('cancel', e => { e.preventDefault(); done(); });
  d.addEventListener('mousedown', e => { if (e.target === d) done(); });
  d.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    if (!picked) return;
    restore.disabled = true;
    try {
      await flush();
      const r = await api.post(`/api/history/restore?${deckQuery()}&id=${encodeURIComponent(picked.id)}`);
      done();
      await replaceDeck({ html: r.html, js: r.js }, { record: true, write: false, label: 'Restore version' });
      toast(`Restored the version from <b>${esc(when(picked.time))}</b>. ⌘Z undoes it; the state before is in History too.`, 6000);
    } catch (err) { restore.disabled = false; toast(esc(err.message)); }
  };
  document.body.append(d);
  d.showModal();
  const first = listEl.querySelector('.history-row');
  if (first) { first.focus(); first.click(); }
}
