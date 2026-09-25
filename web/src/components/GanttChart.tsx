import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskRecord } from '../lib/api';
import {
  axisWidth,
  barGeometry,
  barsFor,
  computeRange,
  dayGridlines,
  dayToISO,
  dayToShort,
  monthSpans,
  parseDay,
  sortBars,
  ticksFor,
  todayX,
  weekendSpans,
  ZOOMS,
  zoomLevel,
  type GanttBar,
  type Zoom,
} from '../lib/gantt';
import { CANONICAL_STATUSES, todayISO } from '../lib/tasks';
import Icon from './Icon';

/** Width of the sticky title column — shared with the CSS via --gantt-label-w.
 *  Narrow viewports get a much thinner column: at 200px it ate half a phone
 *  screen and every bar started underneath it. */
const LABEL_W_WIDE = 200;
const LABEL_W_COMPACT = 132;
/** Below this width the label column (and its metadata) go compact. */
const COMPACT_QUERY = '(max-width: 640px)';
/** Height of the two-tier axis (month band + tick row). Shared via --gantt-axis-h. */
const AXIS_H = 46;
/** Below this bar width there is no room for a title inside the bar. */
const TITLE_IN_BAR_MIN_PX = 120;

const STATUS_LABELS = new Map(CANONICAL_STATUSES.map((c) => [c.id, c.label]));

/** Colour families come from CSS: status-<canonical>, or status-unknown. */
function statusClass(status: string): string {
  return STATUS_LABELS.has(status) ? status : 'unknown';
}

function statusLabel(status: string): string {
  return STATUS_LABELS.get(status) ?? status;
}

function barTitle(b: GanttBar): string {
  const days = b.endDay - b.startDay + 1;
  const span = b.openEnded
    ? `${dayToShort(b.startDay)} → open (no due date)`
    : `${dayToShort(b.startDay)} → ${dayToShort(b.endDay)} · ${days} day${days === 1 ? '' : 's'}`;
  const parts = [b.title, statusLabel(b.status), b.owner ?? 'no owner', span];
  if (b.overdue) parts.push('overdue');
  return parts.join(' · ');
}

/**
 * Timeline (Gantt) mode of the Tasks view (FR-16, restyled in #35). Bars run
 * from a task's `raised` (fallback `created`) to its `due`; a task without a
 * usable due date is drawn as a fading, open-ended bar running to today.
 * Deliberately *no* dependencies, auto-scheduling, critical path or
 * drag-to-reschedule — those are the issue's non-goals.
 */
export default function GanttChart({ tasks, onOpen }: { tasks: TaskRecord[]; onOpen: (path: string) => void }) {
  const [zoom, setZoom] = useState<Zoom>('week');
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  const LABEL_W = compact ? LABEL_W_COMPACT : LABEL_W_WIDE;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  /** Set once the user scrolls/drags/taps the timeline, or changes the zoom. */
  const tookOverRef = useRef(false);

  const todayDay = useMemo(() => parseDay(todayISO()) ?? 0, []);
  const bars = useMemo(() => sortBars(barsFor(tasks, todayDay)), [tasks, todayDay]);
  const range = useMemo(() => computeRange(bars, todayDay), [bars, todayDay]);
  const pxPerDay = zoomLevel(zoom).pxPerDay;
  const axisPx = axisWidth(range, pxPerDay);
  const ticks = useMemo(() => ticksFor(range, zoom, pxPerDay), [range, zoom, pxPerDay]);
  const months = useMemo(() => monthSpans(range, pxPerDay), [range, pxPerDay]);
  const weekends = useMemo(
    () => (pxPerDay >= 8 ? weekendSpans(range, pxPerDay) : []),
    [range, pxPerDay],
  );
  const lineX = todayX(range, pxPerDay, todayDay);

  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const scrollToToday = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, lineX - Math.round((el.clientWidth - LABEL_W) / 3));
  };

  // Land on today on mount — the axis can be long at day zoom, and a timeline
  // whose first paint hides "now" is useless.
  //
  // Two things have to be true for that to work, both learned by measuring:
  //   1. the container must already overflow. On mount the workspace panes are
  //      still sizing, so `scrollLeft` clamps to 0 and today stays off-screen
  //      (it looked correct to a test asserting offsets, and wrong to anyone
  //      looking at the screen). A ResizeObserver re-lands when layout settles.
  //   2. the user wins. Once they scroll, drag or tap the timeline themselves,
  //      landing must stop — including when a pane resize happens later.
  // Re-runs whenever the range or the zoom changes, so `scrollToToday` below
  // always closes over the *current* today offset. (The first version ran only
  // on mount and kept the offset from the zero-task render — 240px into a
  // 31-day placeholder range — so "land on today" scrolled nowhere and today
  // stayed off-screen.)
  useEffect(() => {
    const el = scrollRef.current;
    const grid = gridRef.current;
    if (!el || !grid) return;
    const land = () => {
      if (!tookOverRef.current) scrollToToday();
    };
    const takeOver = () => {
      tookOverRef.current = true;
    };
    // Observe BOTH: the container resizes when a pane changes, and the grid
    // resizes when the tasks arrive or a zoom level changes.
    const ro = new ResizeObserver(() => requestAnimationFrame(land));
    ro.observe(el);
    ro.observe(grid);
    const raf = requestAnimationFrame(land);
    el.addEventListener('wheel', takeOver, { passive: true });
    el.addEventListener('pointerdown', takeOver);
    el.addEventListener('touchstart', takeOver, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('wheel', takeOver);
      el.removeEventListener('pointerdown', takeOver);
      el.removeEventListener('touchstart', takeOver);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineX, pxPerDay]);

  return (
    <div className="gantt">
      <div className="gantt-toolbar">
        <div className="gantt-zoom">
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              className={`gantt-zoom-btn ${zoom === z.id ? 'active' : ''}`}
              title={`${z.label} zoom`}
              aria-pressed={zoom === z.id}
              onClick={() => {
                tookOverRef.current = true;
                setZoom(z.id);
              }}
            >
              {z.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="gantt-count">
          {bars.length} task{bars.length === 1 ? '' : 's'}
        </span>
        <button className="gantt-today-btn" title="Scroll to today" onClick={scrollToToday}>
          <Icon name="calendar" size={14} />
          <span>Today</span>
        </button>
      </div>

      <div className="gantt-scroll" ref={scrollRef}>
        <div
          className={`gantt-grid ${compact ? 'gantt-compact' : ''}`}
          ref={gridRef}
          style={
            {
              width: LABEL_W + axisPx,
              '--gantt-label-w': `${LABEL_W}px`,
              '--gantt-axis-h': `${AXIS_H}px`,
              '--gantt-day-w': `${pxPerDay}px`,
            } as React.CSSProperties
          }
        >
          <div className="gantt-axis">
            <div className="gantt-axis-spacer">
              <span className="gantt-axis-corner">Task</span>
            </div>
            <div className="gantt-axis-track" style={{ width: axisPx }}>
              <div className="gantt-months">
                {months.map((m) => (
                  <div key={m.from} className="gantt-month" style={{ left: m.x, width: m.width }}>
                    {m.width >= 60 && <span className="gantt-month-label">{m.label}</span>}
                  </div>
                ))}
                <div className="gantt-today-flag" style={{ left: lineX }} title={`Today — ${dayToISO(todayDay)}`}>
                  Today
                </div>
              </div>
              <div className="gantt-ticks">
                {ticks.map((t) => (
                  <div key={t.day} className={`gantt-tick ${t.major ? 'major' : ''}`} style={{ left: t.x }}>
                    {t.label !== null && <span className="gantt-tick-label">{t.label}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Weekend shading + the today band sit under the rows, offset past the
              sticky title column. The today *line* stays a direct child of the
              grid so its offset is label width + today offset. */}
          <div className="gantt-shading" style={{ left: LABEL_W, width: axisPx }}>
            {weekends.map((s) => (
              <div key={s.from} className="gantt-weekend" style={{ left: s.x, width: s.width }} />
            ))}
            {dayGridlines(range, pxPerDay).map((g) => (
              <div key={`dayline-${g.day}`} className="gantt-gridline day" style={{ left: g.x }} />
            ))}
            {ticks
              .filter((t) => t.major)
              .map((t) => (
                <div key={`line-${t.day}`} className="gantt-gridline" style={{ left: t.x }} />
              ))}
            {months.slice(1).map((m) => (
              <div key={`month-${m.from}`} className="gantt-gridline month" style={{ left: m.x }} />
            ))}
            <div className="gantt-today-band" style={{ left: lineX, width: pxPerDay }} />
          </div>

          <div className="gantt-rows">
            {bars.map((b, i) => {
              const g = barGeometry(b, range, pxPerDay);
              const cls = statusClass(b.status);
              return (
                <div className={`gantt-row ${i % 2 ? 'odd' : ''}`} key={b.path}>
                  <button type="button" className="gantt-label" title={b.path} onClick={() => onOpen(b.path)}>
                    <span className="gantt-label-top">
                      <span className={`gantt-status-dot status-${cls}`} />
                      <span className="gantt-label-title">{b.title}</span>
                    </span>
                    <span className="gantt-label-meta">
                      <span className="gantt-meta-status">{statusLabel(b.status)}</span>
                      {!compact && b.priority && <span>{b.priority}</span>}
                      {!compact && b.owner && <span>{b.owner}</span>}
                      <span className={b.overdue ? 'gantt-meta-overdue' : ''}>
                        {b.openEnded ? 'no due' : dayToShort(b.endDay)}
                      </span>
                    </span>
                  </button>
                  <div className="gantt-track" style={{ width: axisPx }}>
                    <button
                      type="button"
                      className={`gantt-bar status-${cls}${b.overdue ? ' overdue' : ''}${b.openEnded ? ' open-ended' : ''}`}
                      style={{ left: g.x, width: g.width }}
                      title={barTitle(b)}
                      onClick={() => onOpen(b.path)}
                    >
                      {b.priority && <span className="gantt-bar-prio">{b.priority}</span>}
                      {!compact && g.width >= TITLE_IN_BAR_MIN_PX && <span className="gantt-bar-text">{b.title}</span>}
                      {b.openEnded && <span className="gantt-bar-nodue">no due</span>}
                    </button>
                  </div>
                </div>
              );
            })}
            {bars.length === 0 && <div className="gantt-empty">No tasks to place on the timeline.</div>}
          </div>

          <div className="gantt-today" style={{ left: LABEL_W + lineX }} title={`Today — ${dayToISO(todayDay)}`} />
        </div>
      </div>
    </div>
  );
}
