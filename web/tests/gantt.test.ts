import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskRecord } from '../src/lib/api';
import {
  axisWidth,
  barFor,
  barGeometry,
  barsFor,
  computeRange,
  DAY_MS,
  dayToISO,
  EMPTY_RANGE_HALF_DAYS,
  isRealDate,
  MIN_BAR_PX,
  PAD_DAYS,
  parseDay,
  rangeDays,
  sortBars,
  ticksFor,
  todayX,
  xForDay,
  zoomLevel,
} from '../src/lib/gantt';

const TODAY = parseDay('2026-10-01');
if (TODAY === null) throw new Error('fixture date must parse');

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    path: 'Wiki/tasks/one.md',
    title: 'One',
    status: 'open',
    statusRaw: 'open',
    priority: 'P2',
    owner: 'hung',
    due: null,
    raised: null,
    created: null,
    updated: null,
    tags: [],
    ...overrides,
  };
}

test('parseDay accepts real YYYY-MM-DD dates and rejects everything else', () => {
  assert.deepEqual(parseDay('2026-10-01'), Math.floor(Date.UTC(2026, 9, 1) / DAY_MS));
  // Round trip through the same UTC basis.
  assert.equal(dayToISO(parseDay('2026-10-01')!), '2026-10-01');
  assert.equal(parseDay('2026-02-30'), null, 'a rolled-over date must not silently become Mar 2');
  assert.equal(parseDay('2026-13-01'), null);
  assert.equal(parseDay(''), null);
  assert.equal(parseDay(null), null);
  assert.equal(parseDay(undefined), null);
  assert.equal(parseDay('none'), null);
  assert.equal(parseDay('next friday'), null);
});

test('isRealDate mirrors parseDay for the values the vault actually stores', () => {
  assert.equal(isRealDate('2026-09-29'), true);
  assert.equal(isRealDate('none'), false);
  assert.equal(isRealDate(null), false);
});

test('a bar starts at raised, falls back to created, then to today', () => {
  const raised = barFor(task({ raised: '2026-09-10', created: '2026-08-01', due: '2026-10-05' }), TODAY);
  assert.equal(raised.startSource, 'raised');
  assert.equal(dayToISO(raised.startDay), '2026-09-10');

  const created = barFor(task({ created: '2026-08-01', due: '2026-10-05' }), TODAY);
  assert.equal(created.startSource, 'created');
  assert.equal(dayToISO(created.startDay), '2026-08-01');

  const neither = barFor(task({ due: '2026-10-05' }), TODAY);
  assert.equal(neither.startSource, 'today');
  assert.equal(dayToISO(neither.startDay), '2026-10-01');
});

test('a missing / "none" / free-text due is an open-ended bar running to today', () => {
  for (const due of [null, 'none', 'asap']) {
    const bar = barFor(task({ raised: '2026-09-01', due }), TODAY);
    assert.equal(bar.openEnded, true, `due=${String(due)}`);
    assert.equal(bar.endDay, TODAY);
    assert.equal(bar.overdue, false, 'an open-ended bar is never overdue');
  }
});

test('overdue follows the board rule: due in the past and status is not done', () => {
  const past = '2026-09-20';
  assert.equal(barFor(task({ due: past, status: 'open' }), TODAY).overdue, true);
  assert.equal(barFor(task({ due: past, status: 'done' }), TODAY).overdue, false);
  assert.equal(barFor(task({ due: '2026-10-01', status: 'open' }), TODAY).overdue, false, 'due today is not overdue');
  assert.equal(barFor(task({ due: '2026-10-05', status: 'open' }), TODAY).overdue, false);
});

test('a due before the start is clamped to a single day (never a negative width)', () => {
  const bar = barFor(task({ raised: '2026-10-05', due: '2026-09-20' }), TODAY);
  assert.equal(bar.startDay, parseDay('2026-10-05'));
  assert.equal(bar.endDay, bar.startDay);
  assert.equal(bar.overdue, true, 'the malformed due is still reported as overdue');
});

test('computeRange pads both sides and always contains today', () => {
  const bars = barsFor(
    [
      task({ path: 'a.md', raised: '2026-09-10', due: '2026-09-20' }),
      task({ path: 'b.md', raised: '2026-10-20', due: '2026-10-25' }),
    ],
    TODAY,
  );
  const r = computeRange(bars, TODAY);
  assert.equal(dayToISO(r.from), '2026-09-07', 'earliest start minus the pad');
  assert.equal(dayToISO(r.to), '2026-10-28', 'latest due plus the pad');
  assert.equal(rangeDays(r), 52);
  assert.equal(PAD_DAYS, 3);
});

test('computeRange keeps today inside a range made only of past or future tasks', () => {
  const past = computeRange(barsFor([task({ raised: '2026-01-01', due: '2026-01-05' })], TODAY), TODAY);
  assert.ok(past.from <= TODAY && TODAY <= past.to, 'today must be inside a fully-past range');
  assert.equal(dayToISO(past.to), '2026-10-04');

  const future = computeRange(barsFor([task({ raised: '2026-12-01', due: '2026-12-05' })], TODAY), TODAY);
  assert.ok(future.from <= TODAY && TODAY <= future.to, 'today must be inside a fully-future range');
  assert.equal(dayToISO(future.from), '2026-09-28');
});

test('computeRange with no bars is a fixed window around today', () => {
  const r = computeRange([], TODAY);
  assert.equal(r.from, TODAY - EMPTY_RANGE_HALF_DAYS);
  assert.equal(r.to, TODAY + EMPTY_RANGE_HALF_DAYS);
  assert.equal(EMPTY_RANGE_HALF_DAYS, 15);
});

test('geometry: inclusive duration, offset by the padded range, floored at MIN_BAR_PX', () => {
  const bar = barFor(task({ raised: '2026-09-10', due: '2026-09-19' }), TODAY); // 10 days inclusive
  const r = computeRange([bar], TODAY);

  const day = zoomLevel('day');
  const g = barGeometry(bar, r, day.pxPerDay);
  assert.equal(g.x, day.pxPerDay * (parseDay('2026-09-10')! - r.from), 'x = padded offset of the start day');
  assert.equal(g.width, 10 * day.pxPerDay, 'ten inclusive days');

  // A same-day task is one day wide, and at month zoom the floor keeps it visible.
  const sameDay = barFor(task({ raised: '2026-09-10', due: '2026-09-10' }), TODAY);
  const month = zoomLevel('month');
  assert.equal(barGeometry(sameDay, r, day.pxPerDay).width, day.pxPerDay);
  assert.equal(barGeometry(sameDay, r, month.pxPerDay).width, MIN_BAR_PX);
  assert.ok(month.pxPerDay < MIN_BAR_PX, 'the floor only bites at the densest zoom');
  assert.equal(MIN_BAR_PX, 8);
});

test('an open-ended bar covers today\'s column, up to the day after the today line', () => {
  const bar = barFor(task({ raised: '2026-09-01', due: null }), TODAY);
  const r = computeRange([bar], TODAY);
  const px = zoomLevel('week').pxPerDay;
  const g = barGeometry(bar, r, px);
  // Durations are inclusive, so a bar ending today occupies today's whole day
  // column: its right edge is one pxPerDay past the today line, which marks the
  // *start* of today. (The chart draws the line that way on purpose.)
  assert.equal(g.x + g.width, todayX(r, px, TODAY) + px);
  assert.equal(g.x + g.width - px, todayX(r, px, TODAY), 'the line sits on the last day of the bar');
});

test('axis measurements are consistent with the range', () => {
  const r = { from: 100, to: 109 };
  assert.equal(rangeDays(r), 10);
  assert.equal(axisWidth(r, 8), 80);
  assert.equal(xForDay(100, r, 8), 0);
  assert.equal(xForDay(109, r, 8), 72);
  assert.equal(todayX(r, 8, 104), 32);
});

test('sortBars orders by start, then latest due, then title', () => {
  const bars = barsFor(
    [
      task({ path: 'b.md', title: 'B', raised: '2026-09-10', due: '2026-09-12' }),
      task({ path: 'a.md', title: 'A', raised: '2026-09-10', due: '2026-09-20' }),
      task({ path: 'c.md', title: 'C', raised: '2026-09-01', due: '2026-09-05' }),
    ],
    TODAY,
  );
  assert.deepEqual(
    sortBars(bars).map((b) => b.title),
    ['C', 'A', 'B'],
  );
});

test('day zoom labels every day and majors on Mondays', () => {
  const r = { from: parseDay('2026-09-28')!, to: parseDay('2026-10-04')! }; // Mon → Sun
  const px = zoomLevel('day').pxPerDay;
  const ticks = ticksFor(r, 'day', px);
  assert.equal(ticks.length, rangeDays(r), 'one gridline per day');
  assert.equal(ticks[0].x, 0);
  assert.equal(ticks[1].x, px, 'gridlines are one pxPerDay apart');
  // 2026-09-28 is a Monday.
  assert.equal(ticks[0].major, true);
  assert.match(ticks[0].label!, /^09-28$/);
  assert.equal(ticks[2].major, false);
  assert.equal(ticks[2].label, '30');
});

test('week zoom labels Mondays only, month zoom labels the first of each month', () => {
  const r = { from: parseDay('2026-09-25')!, to: parseDay('2026-10-06')! };
  const week = ticksFor(r, 'week', zoomLevel('week').pxPerDay);
  assert.deepEqual(
    week.map((t) => dayToISO(t.day)),
    ['2026-09-28', '2026-10-05'],
    'Mondays inside the range',
  );
  assert.ok(week.every((t) => t.major && t.label));

  const month = ticksFor(r, 'month', zoomLevel('month').pxPerDay);
  assert.deepEqual(month.map((t) => dayToISO(t.day)), ['2026-10-01']);
  assert.equal(month[0].label, 'Oct 2026');
});

test('a range with no Monday / month start still gets one labelled tick', () => {
  const r = { from: parseDay('2026-09-29')!, to: parseDay('2026-09-30')! }; // Tue → Wed
  const week = ticksFor(r, 'week', zoomLevel('week').pxPerDay);
  assert.equal(week.length, 1);
  assert.equal(week[0].x, 0);
  assert.equal(week[0].label, '2026-09-29');
  assert.equal(ticksFor(r, 'month', zoomLevel('month').pxPerDay).length, 1);
});
