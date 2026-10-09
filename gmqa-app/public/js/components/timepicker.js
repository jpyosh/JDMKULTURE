// The app's own time picker for every <input type="time">, matching the calendar: dark, 12-hour
// (hour · minute · AM/PM), with Now, Clear and Done. The input stays a real time input, so typing still
// works and views keep listening to their usual 'change' event (fired once, when the time is applied).
import { shopTime } from '../ui.js';

const pad = n => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

let picker = null; // { el, input, h, m, ampm, changed }

const usable = input => input?.matches?.('input[type=time]') && !input.disabled && !input.readOnly;
// '20:24' → { h: 8, m: '24', ampm: 'PM' }
function split(value) {
  const [H, M] = (/^\d{2}:\d{2}/.test(value || '') ? value : shopTime()).split(':').map(Number);
  return { h: H % 12 || 12, m: pad(M), ampm: H >= 12 ? 'PM' : 'AM' };
}
const join = ({ h, m, ampm }) => `${pad((h % 12) + (ampm === 'PM' ? 12 : 0))}:${m}`;

function apply(value) {
  const { input } = picker;
  const changed = input.value !== value;
  input.value = value;
  close({ refocus: true });
  if (changed) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function close({ refocus = false } = {}) {
  if (!picker) return;
  const { el, input } = picker;
  picker = null;
  if (el.matches?.(':popover-open')) el.hidePopover();
  el.remove();
  if (refocus) input.focus({ preventScroll: true });
}

function render() {
  const { el, h, m, ampm, input } = picker;
  const col = (name, values, current, attr) => `<div class="tp-col" role="listbox" aria-label="${name}">
    ${values.map(v => `<button type="button" role="option" class="tp-opt" ${attr}="${v}" aria-selected="${String(v) === String(current)}">${v}</button>`).join('')}</div>`;
  el.innerHTML = `
    <div class="tp-head"><span class="tp-value">${h}:${m} ${ampm}</span></div>
    <div class="tp-cols">${col('Hour', HOURS, h, 'data-tp-hour')}${col('Minute', MINUTES, m, 'data-tp-minute')}${col('AM or PM', ['AM', 'PM'], ampm, 'data-tp-ampm')}</div>
    <div class="tp-foot">
      <button type="button" class="dp-link" data-tp-now>Now</button>
      <span>${input.required ? '' : '<button type="button" class="dp-link tp-muted" data-tp-clear>Clear</button>'}
        <button type="button" class="dp-link" data-tp-done>Done</button></span>
    </div>`;
  // Show the chosen hour and minute in the middle of their columns.
  el.querySelectorAll('.tp-col').forEach(c => {
    const sel = c.querySelector('[aria-selected="true"]');
    if (sel) c.scrollTop = sel.offsetTop - c.clientHeight / 2 + sel.offsetHeight / 2;
  });
}

function position() {
  if (!picker) return;
  const { el, input } = picker;
  if (window.matchMedia('(max-width:600px)').matches) { el.classList.add('dp-sheet'); el.style.left = el.style.top = ''; return; }
  el.classList.remove('dp-sheet');
  const box = input.getBoundingClientRect();
  const below = box.bottom + 6;
  const top = below + el.offsetHeight > window.innerHeight - 8 && box.top - 6 - el.offsetHeight > 8 ? box.top - 6 - el.offsetHeight : below;
  el.style.left = `${Math.min(Math.max(8, box.left), window.innerWidth - el.offsetWidth - 8)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function open(input) {
  if (picker?.input === input) return;
  close();
  const el = document.createElement('div');
  el.className = 'timepicker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Choose a time');
  const popover = typeof el.showPopover === 'function';
  if (popover) el.setAttribute('popover', 'manual');
  (popover ? document.body : input.closest('dialog') || document.body).append(el);
  picker = { el, input, ...split(input.value), changed: false };
  if (popover) el.showPopover();
  render();
  position();

  el.addEventListener('mousedown', e => e.preventDefault());
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-tp-now]')) return apply(shopTime());
    if (b.matches('[data-tp-clear]')) return apply('');
    if (b.matches('[data-tp-done]')) return apply(join(picker));
    if (b.dataset.tpHour) picker.h = Number(b.dataset.tpHour);
    if (b.dataset.tpMinute) picker.m = b.dataset.tpMinute;
    if (b.dataset.tpAmpm) picker.ampm = b.dataset.tpAmpm;
    picker.changed = true;
    const scroll = [...el.querySelectorAll('.tp-col')].map(c => c.scrollTop);
    render();
    el.querySelectorAll('.tp-col').forEach((c, i) => { c.scrollTop = scroll[i]; }); // keep the columns where they were
  });
}

export function installTimePicker() {
  document.addEventListener('click', e => {
    const input = e.target.closest?.('input[type=time]');
    if (!usable(input)) return;
    e.preventDefault();
    open(input);
  });
  document.addEventListener('keydown', e => {
    if (!picker) {
      const input = e.target.closest?.('input[type=time]');
      if (usable(input) && e.altKey && e.key === 'ArrowDown') { e.preventDefault(); open(input); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close({ refocus: true }); } // cancel: nothing changes
    else if (e.key === 'Enter' && picker.el.contains(e.target)) { e.preventDefault(); apply(join(picker)); }
  }, true);
  // Clicking elsewhere keeps what was picked (like pressing Done); typing in the field closes the picker.
  document.addEventListener('mousedown', e => {
    if (!picker || picker.el.contains(e.target) || e.target === picker.input) return;
    if (picker.changed) apply(join(picker)); else close();
  });
  document.addEventListener('input', e => { if (picker && e.target === picker.input) close(); });
  document.addEventListener('focusin', e => {
    if (picker && !picker.el.contains(e.target) && e.target !== picker.input) { if (picker.changed) apply(join(picker)); else close(); }
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', e => { if (picker && !picker.el.contains(e.target)) position(); }, true);
}
