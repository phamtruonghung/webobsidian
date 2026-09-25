import { useEffect, useMemo, useState } from 'react';
import { useStore, type ContextMenuItem } from '../lib/store';
import { api, type TaskRecord, type TreeNode } from '../lib/api';
import {
  columnIdFor,
  columnsFor,
  isMissingStatus,
  isOverdue,
  moveTask,
  restoreTask,
  changeTaskStatus,
  todayISO,
} from '../lib/tasks';
import Icon from './Icon';

const TASK_TEMPLATE_PATH = 'Wiki/templates/task.md';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Every folder path in the vault, in tree order (mirrors FolderPicker's collectFolders). */
function collectFolders(node: TreeNode | null): string[] {
  if (!node) return [];
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    for (const c of n.children ?? []) {
      if (c.type === 'folder') {
        out.push(c.path);
        walk(c);
      }
    }
  };
  walk(node);
  return out;
}

/**
 * Kanban board over `type: task` notes (FR-15, issue #31 part 1). Loads its own
 * data (independent of the file tree/editor), filters client-side, and moves
 * cards between columns optimistically by rewriting the note's `status:` field.
 */
export default function TasksView() {
  const tree = useStore((s) => s.tree);
  const openFile = useStore((s) => s.openFile);
  const notify = useStore((s) => s.notify);
  const openContextMenu = useStore((s) => s.openContextMenu);

  const folders = useMemo(() => collectFolders(tree), [tree]);

  const [folder, setFolder] = useState('');
  const [priority, setPriority] = useState('');
  const [owner, setOwner] = useState('');
  const [q, setQ] = useState('');
  // Timeline (issue #32) isn't built yet — the toggle exists so the URL/state
  // shape is stable, but only the Board option is shown for now: any `?mode`
  // value other than `board` (incl. `timeline`) is treated as `board`.
  const [mode, setMode] = useState<'board' | 'timeline'>('board');

  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const load = async (f: string) => {
    setLoading(true);
    setLoadError('');
    try {
      const { tasks: loaded } = await api.tasks(f ? { folder: f } : undefined);
      setTasks(loaded);
    } catch (e: unknown) {
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  // Auto-refresh (debounced) when a watched note inside the folder scope changes.
  useEffect(() => {
    let timer: number | undefined;
    const onFs = (e: Event) => {
      const p: string | undefined = (e as CustomEvent).detail?.path;
      if (!p || !/\.(md|markdown)$/i.test(p)) return;
      if (folder && !(p === folder || p.startsWith(`${folder}/`))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => load(folder), 500);
    };
    window.addEventListener('wo-fs', onFs);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('wo-fs', onFs);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  const filtered = useMemo(() => {
    const p = priority.trim().toLowerCase();
    const o = owner.trim().toLowerCase();
    const lc = q.trim().toLowerCase();
    return tasks.filter(
      (t) =>
        (!p || (t.priority ?? '').toLowerCase() === p) &&
        (!o || (t.owner ?? '').toLowerCase() === o) &&
        (!lc || t.title.toLowerCase().includes(lc)),
    );
  }, [tasks, priority, owner, q]);

  const columns = useMemo(() => columnsFor(filtered), [filtered]);
  const today = useMemo(() => todayISO(), []);

  const priorityOptions = useMemo(
    () => [...new Set(tasks.map((t) => t.priority).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b)),
    [tasks],
  );
  const ownerOptions = useMemo(
    () => [...new Set(tasks.map((t) => t.owner).filter((o): o is string => !!o))].sort((a, b) => a.localeCompare(b)),
    [tasks],
  );

  const move = async (path: string, statusId: string) => {
    const previous = tasks.find((t) => t.path === path);
    if (!previous || columnIdFor(previous) === statusId) return; // already there — don't touch the note
    setTasks((cur) => moveTask(cur, path, statusId));
    try {
      await changeTaskStatus(path, statusId);
    } catch (e: unknown) {
      // Restore just this card — an auto-refresh may have landed a fresher
      // board snapshot while the write was in flight; don't clobber it.
      setTasks((cur) => restoreTask(cur, previous));
      notify(`Could not move "${previous.title}": ${errorMessage(e)}`);
    }
  };

  const moveMenuItems = (task: TaskRecord, currentColId: string): ContextMenuItem[] =>
    columns
      .filter((c) => c.id !== currentColId)
      .map((c) => ({ label: `Move to → ${c.label}`, onClick: () => move(task.path, c.id) }));

  const onCardContextMenu = (e: React.MouseEvent, task: TaskRecord, colId: string) => {
    e.preventDefault();
    openContextMenu({ x: e.clientX, y: e.clientY, items: moveMenuItems(task, colId) });
  };

  // Touch-friendly fallback for drag & drop.
  const onCardMenuButton = (e: React.MouseEvent, task: TaskRecord, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ x: Math.round(rect.left), y: Math.round(rect.bottom) + 4, items: moveMenuItems(task, colId) });
  };

  const toolbar = (
    <div className="tasks-toolbar">
      <select className="text-input" value={folder} onChange={(e) => setFolder(e.target.value)} title="Folder scope">
        <option value="">Whole vault</option>
        {folders.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <select className="text-input" value={priority} onChange={(e) => setPriority(e.target.value)} title="Priority">
        <option value="">Any priority</option>
        {priorityOptions.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select className="text-input" value={owner} onChange={(e) => setOwner(e.target.value)} title="Owner">
        <option value="">Any owner</option>
        {ownerOptions.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <input className="text-input" placeholder="Search titles…" value={q} onChange={(e) => setQ(e.target.value)} />
      <span className="grow" />
      <div className="seg">
        <button
          className={mode === 'board' ? 'active' : ''}
          title="Board view"
          onClick={() => {
            setMode('board');
            window.history.replaceState(null, '', '/tasks?mode=board');
          }}
        >
          Board
        </button>
        {/* Timeline ships with issue #32 — kept in the markup, hidden, so ?mode=timeline has somewhere to land. */}
        <button className={mode === 'timeline' ? 'active' : ''} title="Timeline view" hidden>
          Timeline
        </button>
      </div>
      <button className="tool-btn" title="Refresh" onClick={() => load(folder)} disabled={loading}>
        <Icon name="refresh-cw" size={16} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
      </button>
    </div>
  );

  if (!loading && !loadError && tasks.length === 0) {
    return (
      <div className="tasks-view">
        {toolbar}
        <div className="empty-state tasks-empty">
          <div>
            <div className="big">
              <Icon name="check-square" size={48} />
            </div>
            <p>
              No tasks found. Add <code>type: task</code> to a note's frontmatter to see it on this board.
            </p>
            <button className="tool-btn tasks-empty-link" onClick={() => openFile(TASK_TEMPLATE_PATH)}>
              Open {TASK_TEMPLATE_PATH}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-view">
      {toolbar}
      {loadError && <div className="tasks-error">{loadError}</div>}
      <div className="tasks-board">
        {columns.map((col) => (
          <div
            key={col.id}
            className={`task-column ${dragOverCol === col.id ? 'drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverCol(col.id);
            }}
            onDragLeave={() => setDragOverCol((c) => (c === col.id ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverCol(null);
              const path = e.dataTransfer.getData('text/wo-task');
              if (path) move(path, col.id);
            }}
          >
            <div className="task-column-head">
              <span className="task-column-title">{col.label}</span>
              <span className="task-column-count">{col.tasks.length}</span>
            </div>
            <div className="task-column-body">
              {col.tasks.map((t) => (
                <div
                  key={t.path}
                  className="task-card"
                  draggable
                  role="button"
                  tabIndex={0}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/wo-task', t.path);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => openFile(t.path)}
                  onKeyDown={(e) => {
                    // Only when the card itself is focused — Enter on the "⋯"
                    // button must open its Move-to menu, not the note.
                    if (e.key === 'Enter' && e.target === e.currentTarget) openFile(t.path);
                  }}
                  onContextMenu={(e) => onCardContextMenu(e, t, col.id)}
                  title={t.path}
                >
                  <div className="task-card-head">
                    <span className="task-card-title">{t.title}</span>
                    {isMissingStatus(t) && <span className="task-dot" title="no status field" />}
                    <button
                      className="task-card-menu"
                      title="Move to…"
                      onClick={(e) => onCardMenuButton(e, t, col.id)}
                    >
                      <Icon name="more-horizontal" size={14} />
                    </button>
                  </div>
                  {(t.priority || t.owner || t.due) && (
                    <div className="task-card-meta">
                      {t.priority && <span className="task-badge task-priority">{t.priority}</span>}
                      {t.owner && <span className="task-badge task-owner">{t.owner}</span>}
                      {t.due && (
                        <span className={`task-badge task-due ${isOverdue(t, today) ? 'overdue' : ''}`}>
                          {t.due}
                        </span>
                      )}
                    </div>
                  )}
                  {t.tags.length > 0 && (
                    <div className="task-card-tags">
                      {t.tags.map((tag) => (
                        <span key={tag} className="tag-pill">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="task-card-path">{t.path}</div>
                </div>
              ))}
              {col.tasks.length === 0 && <div className="task-column-empty">No tasks</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
