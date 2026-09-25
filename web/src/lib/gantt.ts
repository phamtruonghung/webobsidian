// Pure date + geometry logic for the Tasks timeline (FR-16, issue #32).
//
// The vault stores plain `YYYY-MM-DD` dates and the axis only ever shows
// dates, so every calculation works on integer UTC *day indices* (days since
// the epoch). Arithmetic stays exact that way: no DST shift can make a bar or
// the today line drift by a day, and the whole module is testable without a
// DOM, a clock, or a timezone.
import type { TaskRecord } from './api';

export type Zoom = 'day' | 'week' | 'month';

export interface ZoomLevel {
  id: Zoom;
  label: string;
  pxPerDay: number;
}

/** Zoom levels — the only difference between them is pixels per day. */
export const ZOOMS: ZoomLevel[] = [
  { id: 'day', label: 'Day', pxPerDay: 40 },
  { id: 'week', label: 'Week', pxPerDay: 16 },
  { id: 'month', label: 'Month', pxPerDay: 4 },
];

export function zoomLevel(zoom: Zoom): ZoomLevel {
  return ZOOMS.find((z) => z.id === zoom) ?? ZOOMS[0];
}

/** Empty space kept on each side of the fitted range. */
export const PAD_DAYS = 3;
/** Floor for a bar's width — a same-day task still has to be visible and clickable. */
export const MIN_BAR_PX = 8;
/** Half-width of the window used when there is nothing to fit (no tasks at all). */
export const EMPTY_RANGE_HALF_DAYS = 15;
export const DAY_MS = 86_400_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * UTC day index for a `YYYY-MM-DD` string, or null for anything else
 * (`'none'`, an empty value, a free-text date, a non-existent date such as
 * 2026-02-30). Callers treat null as "no date on this field".
 */
export function parseDay(v: string | null | undefined): number | null {
  if (v == null) return null;
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  // Rejects rolled-over dates (2026-02-30 becomes Mar 2 in Date.UTC).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(t / DAY_MS);
}

/** `YYYY-MM-DD` for a day index (the inverse of parseDay). */
export function dayToISO(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** True iff `v` is a date this module can place on the axis. */
export function isRealDate(v: string | null | undefined): boolean {
  return parseDay(v) !== null;
}

export interface GanttBar {
  path: string;
  title: string;
  owner: string | null;
  priority: string | null;
  status: string;
  /** Where the bar starts — `raised`, else `created`, else today (documented fallback). */
  startSource: 'raised' | 'created' | 'today';
  startDay: number;
  endDay: number;
  /** No usable `due` (missing, `none`, or free text) — drawn dashed, running to today. */
  openEnded: boolean;
  /** `due` is in the past and the task isn't done — same rule as the board's isOverdue. */
  overdue: boolean;
}

/**
 * One bar per task: `raised` (fallback `created`, fallback today) → `due`.
 * No new frontmatter fields are involved (FR-16 decision). A `due` before the
 * start date is malformed data and is clamped to a single day, so a bar never
 * renders with a negative width.
 */
export function barFor(task: TaskRecord, todayDay: number): GanttBar {
  const raised = parseDay(task.raised);
  const created = parseDay(task.created);
  const startSource: GanttBar['startSource'] = raised !== null ? 'raised' : created !== null ? 'created' : 'today';
  const startDay = raised ?? created ?? todayDay;
  const due = parseDay(task.due);
  const openEnded = due === null;
  const rawEnd = due ?? todayDay;
  return {
    path: task.path,
    title: task.title,
    owner: task.owner,
    priority: task.priority,
    status: task.status,
    startSource,
    startDay,
    endDay: Math.max(rawEnd, startDay),
    openEnded,
    overdue: !openEnded && rawEnd < todayDay && task.status !== 'done',
  };
}

export function barsFor(tasks: TaskRecord[], todayDay: number): GanttBar[] {
  return tasks.map((t) => barFor(t, todayDay));
}

/** Earliest start first, then latest due, then title — a stable reading order. */
export function sortBars(bars: GanttBar[]): GanttBar[] {
  return [...bars].sort(
    (a, b) => a.startDay - b.startDay || b.endDay - a.endDay || a.title.localeCompare(b.title),
  );
}

export interface Range {
  from: number;
  to: number;
}

/**
 * Fitted, padded range over every bar — always containing today, so the today
 * line can never sit outside the drawn axis. With no bars, a fixed window
 * around today keeps the axis (and its labels) meaningful instead of empty.
 */
export function computeRange(bars: GanttBar[], todayDay: number, pad = PAD_DAYS): Range {
  if (bars.length === 0) {
    return { from: todayDay - EMPTY_RANGE_HALF_DAYS, to: todayDay + EMPTY_RANGE_HALF_DAYS };
  }
  let min = todayDay;
  let max = todayDay;
  for (const b of bars) {
    min = Math.min(min, b.startDay, b.endDay);
    max = Math.max(max, b.startDay, b.endDay);
  }
  return { from: min - pad, to: max + pad };
}

/** Inclusive day count of a range (a single-day range is 1). */
export function rangeDays(r: Range): number {
  return r.to - r.from + 1;
}

/** Total width of the axis in pixels. */
export function axisWidth(r: Range, pxPerDay: number): number {
  return rangeDays(r) * pxPerDay;
}

/** Left offset of a day within the axis. */
export function xForDay(day: number, r: Range, pxPerDay: number): number {
  return (day - r.from) * pxPerDay;
}

/**
 * Bar rect inside the axis. Duration is inclusive of both end days, so a task
 * due the day it was raised spans one day; anything narrower than
 * `MIN_BAR_PX` (notably a same-day bar at month zoom) is floored so it stays
 * visible and clickable.
 */
export function barGeometry(bar: GanttBar, r: Range, pxPerDay: number): { x: number; width: number } {
  const days = bar.endDay - bar.startDay + 1;
  return {
    x: xForDay(bar.startDay, r, pxPerDay),
    width: Math.max(days * pxPerDay, MIN_BAR_PX),
  };
}

/** Left offset of the today line. */
export function todayX(r: Range, pxPerDay: number, todayDay: number): number {
  return xForDay(todayDay, r, pxPerDay);
}

const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `Sep 28` — the axis label format (a date, not `09-28`). */
export function dayToShort(day: number): string {
  const dt = new Date(day * DAY_MS);
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

/** `September 2026` — the month band label. */
export function monthLabel(day: number): string {
  const dt = new Date(day * DAY_MS);
  return `${FULL_MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

export function isWeekend(day: number): boolean {
  const dow = new Date(day * DAY_MS).getUTCDay();
  return dow === 0 || dow === 6;
}

export interface Span {
  from: number;
  to: number;
  x: number;
  width: number;
}

/** Consecutive weekend days merged into spans (Sat + Sun render as one block). */
export function weekendSpans(r: Range, pxPerDay: number): Span[] {
  const out: Span[] = [];
  let start: number | null = null;
  for (let day = r.from; day <= r.to + 1; day++) {
    if (day <= r.to && isWeekend(day)) {
      if (start === null) start = day;
      continue;
    }
    if (start !== null) {
      const to = day - 1;
      out.push({ from: start, to, x: xForDay(start, r, pxPerDay), width: (to - start + 1) * pxPerDay });
      start = null;
    }
  }
  return out;
}

export interface MonthSpan extends Span {
  label: string;
}

/** One block per calendar month intersecting the range — the axis band. */
export function monthSpans(r: Range, pxPerDay: number): MonthSpan[] {
  const out: MonthSpan[] = [];
  let day = r.from;
  while (day <= r.to) {
    const dt = new Date(day * DAY_MS);
    const nextMonth = Math.floor(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) / DAY_MS);
    const to = Math.min(nextMonth - 1, r.to);
    out.push({ from: day, to, x: xForDay(day, r, pxPerDay), width: (to - day + 1) * pxPerDay, label: monthLabel(day) });
    day = to + 1;
  }
  return out;
}

/**
 * One entry per day, for the light alignment hairlines. Deliberately derived
 * from the range rather than from `ticksFor` — at week zoom every tick is a
 * Monday, so a tick-derived list would be empty exactly where the hairlines are
 * most useful.
 */
export function dayGridlines(r: Range, pxPerDay: number, minPxPerDay = 12): { day: number; x: number }[] {
  if (pxPerDay < minPxPerDay) return [];
  const out: { day: number; x: number }[] = [];
  for (let day = r.from; day <= r.to; day++) out.push({ day, x: xForDay(day, r, pxPerDay) });
  return out;
}

export interface Tick {
  day: number;
  x: number;
  /** Null when this gridline carries no label at this zoom. */
  label: string | null;
  major: boolean;
}

/**
 * Axis gridlines and labels: every day at `day` zoom, every Monday at `week`
 * zoom, the first of each month at `month` zoom. A range that contains no
 * such day still gets one labelled tick at its start, so the axis is never
 * unlabelled.
 */
export function ticksFor(r: Range, zoom: Zoom, pxPerDay: number): Tick[] {
  const out: Tick[] = [];
  for (let day = r.from; day <= r.to; day++) {
    const dt = new Date(day * DAY_MS);
    const dow = dt.getUTCDay(); // 0 = Sunday
    const dom = dt.getUTCDate();
    if (zoom === 'day') {
      const major = dow === 1;
      out.push({ day, x: xForDay(day, r, pxPerDay), label: major ? dayToShort(day) : String(dom).padStart(2, '0'), major });
    } else if (zoom === 'week') {
      if (dow === 1) out.push({ day, x: xForDay(day, r, pxPerDay), label: dayToShort(day), major: true });
    } else if (dom === 1) {
      out.push({ day, x: xForDay(day, r, pxPerDay), label: `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`, major: true });
    }
  }
  if (out.length === 0) {
    out.push({ day: r.from, x: 0, label: dayToISO(r.from), major: true });
  }
  return out;
}
