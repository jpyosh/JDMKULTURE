// The app's own calendar for every <input type="date">: dark, Sunday-first (the shop's pay week),
// with Today, month arrows and full keyboard support. The input stays a real date input, so typing a
// date still works and every view keeps listening to its usual 'change' event.
import { todayLocal, addDays } from '../ui.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = value => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null);
const longLabel = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

let picker = null; // { el, input, year, month, focus }

const usable = input => input?.matches?.('input[type=date]') && !input.disabled && !input.readOnly;
const inRange = (input, date) => (!input.min || date >= input.min) && (!input.max || date <= input.max);

function close({ refocus = false } = {}) {
  if (!picker) return;
  const { el, input } = picker;
  picker = null;
  if (el.matches?.(':popover-open')) el.hidePopover();
  el.remove();
  if (refocus) input.focus({ preventScroll: true });
}

function choose(date) {
  const { input } = picker;
  if (!inRange(input, date)) return;
  const changed = input.value !== date;
  input.value = date;
  close({ refocus: true });
  if (changed) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function render() {
  const { el, input, year, month, focus } = picker;
  const selected = parse(input.value);
  const today = todayLocal();
  const first = iso(year, month, 1);
  const start = addDays(first, -new Date(`${first}T00:00:00Z`).getUTCDay()); // the Sunday on or before the 1st
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  el.innerHTML = `
    <div class="dp-head">
      <button type="button" class="dp-nav" data-dp-prev aria-label="Previous month">‹</button>
      <div class="dp-title" aria-live="polite">${MONTHS[month]} ${year}</div>
      <button type="button" class="dp-nav" data-dp-next aria-label="Next month">›</button>
    </div>
    <div class="dp-grid" role="grid" aria-label="${MONTHS[month]} ${year}">
      ${WEEKDAYS.map(w => `<div class="dp-weekday" role="columnheader">${w}</div>`).join('')}
      ${days.map(d => {
        const outside = Number(d.slice(5, 7)) - 1 !== month;
        const cls = ['dp-day', outside && 'dp-outside', d === today && 'dp-today'].filter(Boolean).join(' ');
        return `<button type="button" role="gridcell" class="${cls}" data-date="${d}" tabindex="${d === focus ? 0 : -1}"
          aria-selected="${d === selected}" aria-label="${longLabel(d)}" ${inRange(input, d) ? '' : 'disabled'}>${Number(d.slice(8))}</button>`;
      }).join('')}
    </div>
    <div class="dp-foot">
      <button type="button" class="dp-link" data-dp-today ${inRange(input, today) ? '' : 'disabled'}>Today</button>
      <button type="button" class="dp-link" data-dp-close>Close</button>
    </div>`;
}

function show(focusDate, { focusDay = false } = {}) {
  picker.focus = focusDate;
  picker.year = Number(focusDate.slice(0, 4));
  picker.month = Number(focusDate.slice(5, 7)) - 1;
  render();
  if (focusDay) picker.el.querySelector(`[data-date="${focusDate}"]`)?.focus();
}

function position() {
  if (!picker) return;
  const { el, input } = picker;
  if (window.matchMedia('(max-width:600px)').matches) { el.classList.add('dp-sheet'); el.style.left = el.style.top = ''; return; }
  el.classList.remove('dp-sheet');
  const box = input.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const below = box.bottom + 6;
  const top = below + h > window.innerHeight - 8 && box.top - 6 - h > 8 ? box.top - 6 - h : below;
  const left = Math.min(Math.max(8, box.left), window.innerWidth - w - 8);
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function open(input) {
  if (picker?.input === input) return;
  close();
  const el = document.createElement('div');
  el.className = 'datepicker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Choose a date');
  // A popover sits in the top layer, so the calendar also shows above open dialogs (modals).
  const popover = typeof el.showPopover === 'function';
  if (popover) el.setAttribute('popover', 'manual');
  (popover ? document.body : input.closest('dialog') || document.body).append(el);
  picker = { el, input };
  show(parse(input.value) || todayLocal());
  if (popover) el.showPopover();
  position();

  el.addEventListener('mousedown', e => e.preventDefault()); // keep focus where it is while clicking around the calendar
  el.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.matches('[data-dp-prev], [data-dp-next]')) {
      const step = t.matches('[data-dp-next]') ? 1 : -1;
      const m = new Date(Date.UTC(picker.year, picker.month + step, 1));
      show(iso(m.getUTCFullYear(), m.getUTCMonth(), 1));
      position();
    } else if (t.matches('[data-dp-today]')) choose(todayLocal());
    else if (t.matches('[data-dp-close]')) close({ refocus: true });
    else if (t.dataset.date) choose(t.dataset.date);
  });
  el.addEventListener('keydown', e => {
    const current = e.target.closest('[data-date]')?.dataset.date;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next = null;
    if (current && e.key in moves) next = addDays(current, moves[e.key]);
    else if (current && (e.key === 'PageUp' || e.key === 'PageDown')) {
      const [y, m, d] = current.split('-').map(Number);
      const target = new Date(Date.UTC(y, m - 1 + (e.key === 'PageDown' ? 1 : -1), 1));
      const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      next = iso(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last));
    } else if (current && e.key === 'Home') next = addDays(current, -new Date(`${current}T00:00:00Z`).getUTCDay());
    else if (current && e.key === 'End') next = addDays(current, 6 - new Date(`${current}T00:00:00Z`).getUTCDay());
    if (!next) return;
    e.preventDefault();
    show(next, { focusDay: true });
    position();
  });
}

export function installDatePicker() {
  // Open on click (the browser's own calendar icon is hidden in style.css), or Alt+↓ / Enter from the keyboard.
  document.addEventListener('click', e => {
    const input = e.target.closest?.('input[type=date]');
    if (!usable(input)) return;
    e.preventDefault(); // no native popup (Firefox opens one on click)
    open(input);
  });
  document.addEventListener('keydown', e => {
    if (picker && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close({ refocus: true }); return; }
    const input = e.target.closest?.('input[type=date]');
    if (usable(input) && ((e.altKey && e.key === 'ArrowDown') || e.key === 'Enter')) {
      e.preventDefault();
      open(input);
      picker?.el.querySelector('[tabindex="0"]')?.focus();
    }
  }, true);
  // Typing in the input updates the calendar; anything else taking focus or a click elsewhere closes it.
  document.addEventListener('input', e => {
    if (picker && e.target === picker.input && parse(picker.input.value)) { show(picker.input.value); position(); }
  });
  document.addEventListener('mousedown', e => {
    if (picker && !picker.el.contains(e.target) && e.target !== picker.input) close();
  });
  document.addEventListener('focusin', e => {
    if (picker && !picker.el.contains(e.target) && e.target !== picker.input) close();
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
}
