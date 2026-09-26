import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type SearchHit, type MatchContext, type NoteMatches } from '../lib/api';
import { useStore } from '../lib/store';
import Icon from './Icon';
import { cleanSnippet } from '../lib/snippet';

type SortMode = 'relevance' | 'name-asc' | 'name-desc' | 'path-asc';

const SORT_LABELS: Record<SortMode, string> = {
  relevance: 'Relevance',
  'name-asc': 'File name (A to Z)',
  'name-desc': 'File name (Z to A)',
  'path-asc': 'Path (A to Z)',
};

/** Render a match context with its highlighted ranges as React nodes. */
function highlight(raw: MatchContext): ReactNode[] {
  const out: ReactNode[] = [];
  const c = { ...raw, ...cleanSnippet(raw.text, raw.ranges) };
  const ranges = [...c.ranges].sort((a, b) => a[0] - b[0]);
  let pos = 0;
  if (c.pre) out.push('…');
  ranges.forEach(([s, l], i) => {
    const start = Math.max(pos, s);
    if (start > pos) out.push(c.text.slice(pos, start));
    const end = Math.min(c.text.length, s + l);
    if (end > start) out.push(<mark key={i}>{c.text.slice(start, end)}</mark>);
    pos = Math.max(pos, end);
  });
  out.push(c.text.slice(pos));
  if (c.post) out.push('…');
  return out;
}

export default function SearchPanel() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [matches, setMatches] = useState<Map<string, NoteMatches>>(new Map());
  const [matchCase, setMatchCase] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [moreContext, setMoreContext] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [sort, setSort] = useState<SortMode>('relevance');
  const [sortOpen, setSortOpen] = useState(false);
  const [visible, setVisible] = useState(50); // render incrementally to stay smooth
  const [noteOverride, setNoteOverride] = useState<Map<string, boolean>>(new Map());
  const openFile = useStore((s) => s.openFile);
  const searchQuery = useStore((s) => s.searchQuery);
  const timer = useRef<number>();
  const sentinel = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inflight = useRef<Set<string>>(new Set());
  const queryRef = useRef(q);
  const caseRef = useRef(matchCase);
  queryRef.current = q;
  caseRef.current = matchCase;

  // adopt a query pushed from elsewhere (e.g. clicking a tag node in the graph)
  useEffect(() => {
    if (searchQuery) setQ(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await api.search(q); // no limit — server returns every match
        setHits(r.hits);
      } catch {
        setHits([]);
      }
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  // Reset the render window when the result set or its ordering changes.
  useEffect(() => setVisible(50), [hits, sort, matchCase]);
  // Drop cached per-note matches + collapse overrides when the query changes.
  useEffect(() => {
    setMatches(new Map());
    setNoteOverride(new Map());
    inflight.current.clear();
  }, [q, matchCase]);
  // Toggling the global collapse switch clears individual overrides.
  useEffect(() => setNoteOverride(new Map()), [collapsed]);

  // Apply client-side sort (match-case filtering is now done server-side via
  // the per-note scan, so it no longer drops notes from the list here).
  const shown = useMemo(() => {
    const sorted = [...hits];
    switch (sort) {
      case 'name-asc':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'name-desc':
        sorted.sort((a, b) => b.title.localeCompare(a.title));
        break;
      case 'path-asc':
        sorted.sort((a, b) => a.path.localeCompare(b.path));
        break;
      default:
        break; // relevance = server order
    }
    return sorted;
  }, [hits, sort]);

  // Lazily fetch highlighted match contexts for the notes currently rendered.
  useEffect(() => {
    if (!q.trim()) return;
    const need = shown
      .slice(0, visible)
      .map((h) => h.path)
      .filter((p) => !matches.has(p) && !inflight.current.has(p));
    if (!need.length) return;
    const batch = need.slice(0, 60);
    batch.forEach((p) => inflight.current.add(p));
    const qAt = q;
    const caseAt = matchCase;
    api
      .searchMatches(qAt, batch, caseAt)
      .then((r) => {
        if (qAt !== queryRef.current || caseAt !== caseRef.current) return; // stale
        setMatches((prev) => {
          const next = new Map(prev);
          for (const m of r.matches) next.set(m.path, m);
          return next;
        });
      })
      .catch(() => {})
      .finally(() => batch.forEach((p) => inflight.current.delete(p)));
  }, [shown, visible, q, matchCase, matches]);

  // Load the next chunk when the sentinel at the bottom scrolls into view.
  useEffect(() => {
    if (visible >= shown.length) return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible((v) => Math.min(v + 50, shown.length));
      },
      { root: resultsRef.current, rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, shown.length]);

  const isCollapsed = (p: string) => (noteOverride.has(p) ? !!noteOverride.get(p) : collapsed);
  const toggleNote = (p: string) =>
    setNoteOverride((prev) => {
      const n = new Map(prev);
      n.set(p, !isCollapsed(p));
      return n;
    });

  const totalMatches = useMemo(() => {
    let t = 0;
    for (const m of matches.values()) t += m.count;
    return t;
  }, [matches]);

  return (
    <div className="search-panel">
      <div className="search-head">
        <div className="search-input-wrap">
          <Icon name="search" size={15} className="search-lead" />
          <input
            className="search-input has-lead"
            placeholder="Search   (try tag:idea, path:notes)"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            className={`search-icon-btn ${matchCase ? 'active' : ''}`}
            title="Match case"
            onClick={() => setMatchCase((v) => !v)}
          >
            Aa
          </button>
          {q && (
            <button className="search-icon-btn" title="Clear" onClick={() => setQ('')}>
              <Icon name="x" size={15} />
            </button>
          )}
          <button
            className={`search-icon-btn ${showOptions ? 'active' : ''}`}
            title="Search options"
            onClick={() => setShowOptions((v) => !v)}
          >
            <Icon name="sliders" size={15} />
          </button>
        </div>

        {showOptions && (
          <div className="search-options">
            <label className="search-opt">
              <span>Collapse results</span>
              <input type="checkbox" checked={collapsed} onChange={(e) => setCollapsed(e.target.checked)} />
            </label>
            <label className="search-opt">
              <span>Show more context</span>
              <input type="checkbox" checked={moreContext} onChange={(e) => setMoreContext(e.target.checked)} />
            </label>
          </div>
        )}

        {q && (
          <div className="search-meta">
            <span>
              {shown.length} note{shown.length === 1 ? '' : 's'}
              {totalMatches > 0 && ` · ${totalMatches}${visible < shown.length ? '+' : ''} matches`}
            </span>
            <span className="grow" />
            <div className="search-sort">
              <button className="search-sort-btn" onClick={() => setSortOpen((v) => !v)}>
                {SORT_LABELS[sort]}
                <Icon name="chevron-down" size={13} />
              </button>
              {sortOpen && (
                <>
                  <div className="search-sort-backdrop" onClick={() => setSortOpen(false)} />
                  <div className="search-sort-menu">
                    {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                      <button
                        key={m}
                        className={sort === m ? 'active' : ''}
                        onClick={() => {
                          setSort(m);
                          setSortOpen(false);
                        }}
                      >
                        <Icon name="check" size={14} style={{ opacity: sort === m ? 1 : 0 }} />
                        {SORT_LABELS[m]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="search-results" ref={resultsRef}>
        {shown.slice(0, visible).map((h) => {
          const m = matches.get(h.path);
          const noteCollapsed = isCollapsed(h.path);
          const contexts = m?.contexts ?? [];
          return (
            <div key={h.path} className="result-group">
              <div className="rg-head" title={h.path}>
                <button
                  className="rg-twisty"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleNote(h.path);
                  }}
                >
                  <Icon name={noteCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                </button>
                <span className="rg-title" onClick={() => openFile(h.path)}>
                  {h.title}
                </span>
                {m && m.count > 0 && <span className="rg-badge">{m.count}</span>}
              </div>
              {!noteCollapsed && (
                <div className="rg-body">
                  {contexts.length > 0 ? (
                    contexts.map((c, i) => (
                      <div
                        key={i}
                        className={`rg-match ${moreContext ? 'expanded' : ''}`}
                        onClick={() => openFile(h.path)}
                      >
                        {highlight(c)}
                      </div>
                    ))
                  ) : (
                    h.snippet && (
                      <div
                        className={`rg-match ${moreContext ? 'expanded' : ''}`}
                        onClick={() => openFile(h.path)}
                      >
                        {cleanSnippet(h.snippet, []).text}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={sentinel} />
        {visible < shown.length && (
          <div className="search-more">Showing {visible} of {shown.length}…</div>
        )}
      </div>
    </div>
  );
}
