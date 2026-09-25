// Deep-link URL sync (FR-10): the browser URL mirrors the open note as
// /note/<vault-relative-path> (Graph view = /graph, Tasks board = /tasks).
// Opening such a URL after login opens the note; browser back/forward
// navigate via popstate.
import { useStore, GRAPH_PATH, TASKS_PATH, type TasksMode } from './store';

/**
 * Deep link for a path. The Tasks view carries its mode in the query string
 * (FR-16): without it, `replaceState(pathToUrl(TASKS_PATH))` during a
 * workspace restore would silently drop `/tasks?mode=timeline` back to the
 * board. The board stays the bare `/tasks`.
 */
export function pathToUrl(path: string | null, tasksMode: TasksMode = 'board'): string {
  if (!path) return '/';
  if (path === GRAPH_PATH) return '/graph';
  if (path === TASKS_PATH) return tasksMode === 'timeline' ? '/tasks?mode=timeline' : '/tasks';
  return `/note/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Vault path encoded in a location pathname, or null if it isn't a deep link. */
/** The Tasks mode a URL asks for, or null when the URL says nothing about it. */
export function modeFromUrl(pathname: string, search: string): TasksMode | null {
  if (pathname !== '/tasks') return null;
  const m = new URLSearchParams(search).get('mode');
  if (m === 'timeline') return 'timeline';
  if (m === 'board') return 'board';
  return null;
}

export function urlToPath(pathname: string): string | null {
  if (pathname === '/graph') return GRAPH_PATH;
  if (pathname === '/tasks') return TASKS_PATH;
  if (pathname.startsWith('/note/')) {
    try {
      const rel = pathname.slice('/note/'.length).split('/').map(decodeURIComponent).join('/');
      return rel || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True while we're applying a popstate — suppresses the pushState echo. */
let applyingPop = false;
let started = false;

/**
 * Start two-way sync. Call once after auth. Returns the deep-linked path that
 * was present in the URL at load time (to open after the workspace restores).
 */
export function initUrlSync(): string | null {
  const initial = urlToPath(window.location.pathname);
  // A deep link (or a reload) wins over whatever mode was persisted — this is
  // what makes `/tasks?mode=timeline` land on the timeline, not the board.
  const urlMode = modeFromUrl(window.location.pathname, window.location.search);
  if (urlMode) useStore.getState().setTasksMode(urlMode);
  if (started) return initial;
  started = true;

  // store → URL. The very first sync (workspace restore on load) replaces the
  // entry instead of pushing, so Back doesn't land on a stale '/'.
  let firstSync = true;
  useStore.subscribe((state, prev) => {
    if (state.activePath === prev.activePath) return;
    const url = pathToUrl(state.activePath, state.tasksMode);
    if (window.location.pathname === url) return;
    if (applyingPop || firstSync) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    firstSync = false;
  });

  // URL → store (browser back/forward)
  window.addEventListener('popstate', () => {
    const path = urlToPath(window.location.pathname);
    if (!path || path === useStore.getState().activePath) return;
    applyingPop = true;
    Promise.resolve(useStore.getState().openFile(path))
      .catch(() => {})
      .finally(() => {
        applyingPop = false;
      });
  });

  return initial;
}
