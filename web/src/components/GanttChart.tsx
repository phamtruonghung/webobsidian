import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskRecord } from '../lib/api';
import {
  axisWidth,
  barGeometry,
  barsFor,
  computeRange,
  dayToISO,
  parseDay,
  sortBars,
  ticksFor,
  todayX,
  ZOOMS,
  zoomLevel,
  type GanttBar,
  type Zoom,
} from '../lib/gantt';
import { CANONICAL_STATUSES, todayISO } from '../lib/tasks';
import Icon from './Icon';

/** Width of the sticky title column. Shared with the CSS via --gantt-label-w. */
const LABEL_W = 180;

const CANONICAL_IDS = new Set(CANONICAL_STATUSES.map((c) => c.id));

/** Colour families come from CSS: status-<canonical>, or status-unknown. */
function statusClass(status: string): string {
  return CANONICAL_IDS.has(status) ? status : 'unknown';
}

function barTitle(b: GanttBar): string {
  const parts = [b.title, b.status, b.owner ?? 'no owner'];
  parts.push(`${dayToISO(b.startDay)} → ${b.openEnded ? 'no due' : dayToISO(b.endDay)}`);
  if (b.overdue) parts.push('overdue');
  return parts.join(' · ');
}

/**
 * Timeline (Gantt) mode of the Tasks view (FR-16). Bars run from a task's
 * `raised` (fallback `created`) to its `due`; a task without a usable due date
 * is drawn dashed and open-ended, running to today. Deliberately *no*
 * dependencies, auto-scheduling, critical path or drag-to-reschedule — those
 * are the issue's non-goals.
 */
export default function GanttChart({ tasks, onOpen }: { tasks: TaskRecord[]; onOpen: (path: string) => void }) {
  const [zoom, setZoom] = useState<Zoom>('week');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const todayDay = useMemo(() => parseDay(todayISO()) ?? 0, []);
  const bars = useMemo(() => sortBars(barsFor(tasks, todayDay)), [tasks, todayDay]);
  const range = useMemo(() => computeRange(bars, todayDay), [bars, todayDay]);
  const pxPerDay = zoomLevel(zoom).pxPerDay;
  const axisPx = axisWidth(range, pxPerDay);
  const ticks = useMemo(() => ticksFor(range, zoom, pxPerDay), [range, zoom, pxPerDay]);
  const lineX = todayX(range, pxPerDay, todayDay);

  const scrollToToday = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, lineX - Math.round((el.clientWidth - LABEL_W) / 3));
  };

  // Land on today once on mount — the axis can be long at day zoom, and a
  // timeline whose first paint hides "now" is useless. Not re-run on refresh:
  // that would yank the view back while someone is reading a later month.
  useEffect(() => {
    scrollToToday();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="gantt">
      <div className="gantt-toolbar">
        <div className="seg">
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              className={zoom === z.id ? 'active' : ''}
              title={`${z.label} zoom`}
              onClick={() => setZoom(z.id)}
            >
              {z.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="gantt-count">
          {bars.length} task{bars.length === 1 ? '' : 's'}
        </span>
        <button className="tool-btn" title="Scroll to today" onClick={scrollToToday}>
          <Icon name="calendar" size={16} />
        </button>
      </div>

      <div className="gantt-scroll" ref={scrollRef}>
        <div
          className="gantt-grid"
          style={
            {
              width: LABEL_W + axisPx,
              '--gantt-label-w': `${LABEL_W}px`,
              '--gantt-day-w': `${pxPerDay}px`,
            } as React.CSSProperties
          }
        >
          <div className="gantt-axis">
            <div className="gantt-axis-spacer" />
            <div className="gantt-axis-track" style={{ width: axisPx }}>
              {ticks.map((t) => (
                <div key={t.day} className={`gantt-tick ${t.major ? 'major' : ''}`} style={{ left: t.x }}>
                  {t.label !== null && <span className="gantt-tick-label">{t.label}</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="gantt-rows">
            {bars.map((b) => {
              const g = barGeometry(b, range, pxPerDay);
              return (
                <div className="gantt-row" key={b.path}>
                  <button type="button" className="gantt-label" title={b.path} onClick={() => onOpen(b.path)}>
                    <span className="gantt-label-title">{b.title}</span>
                    <span className="gantt-label-meta">
                      {[b.priority, b.owner, b.openEnded ? 'no due' : dayToISO(b.endDay)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                  <div className="gantt-track" style={{ width: axisPx }}>
                    <button
                      type="button"
                      className={`gantt-bar status-${statusClass(b.status)}${b.overdue ? ' overdue' : ''}${
                        b.openEnded ? ' open-ended' : ''
                      }`}
                      style={{ left: g.x, width: g.width }}
                      title={barTitle(b)}
                      onClick={() => onOpen(b.path)}
                    >
                      {b.priority && <span className="gantt-bar-badge">{b.priority}</span>}
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
