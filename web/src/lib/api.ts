// Thin fetch wrapper around the WebObsidian server API.

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  ext?: string;
  size?: number;
  mtime?: number;
  ctime?: number;
  children?: TreeNode[];
  /** Set by the server from `_system/locks.json`: the browser must not edit this path. */
  locked?: boolean;
  lockReason?: string;
}

export interface TrashItem {
  name: string;
  path: string; // includes the .trash/ prefix
  original: string; // where it restores to
  ext: string;
  size: number;
  mtime: number;
}

export interface ShareRecord {
  id: string;
  path: string;
  enabled: boolean;
  createdAt: string;
  hasPassword?: boolean;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  tags: string[];
  snippet: string;
}

export interface MatchContext {
  text: string;
  ranges: [number, number][];
  pre: boolean;
  post: boolean;
}

export interface NoteMatches {
  path: string;
  count: number;
  contexts: MatchContext[];
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
}

// Tasks board (FR-15) query params. Keep in sync with server/src/services/tasks.ts's TaskFilter.
export interface TaskQuery {
  folder?: string;
  status?: string;
  priority?: string;
  owner?: string;
  q?: string;
}

// Tasks board (FR-15). Keep in sync with server/src/services/tasks.ts's TaskRecord.
export interface TaskRecord {
  path: string; // vault-relative
  title: string; // frontmatter title, fallback file name without extension
  status: string; // canonical id if canonical/alias; else the raw value unchanged; 'open' when missing
  statusRaw: string | null; // raw frontmatter value as a string; null when the key is absent/empty
  priority: string | null;
  owner: string | null;
  due: string | null; // 'YYYY-MM-DD' | other raw string (e.g. 'none') | null
  raised: string | null;
  created: string | null;
  updated: string | null;
  tags: string[];
}

/**
 * Unlocking a locked note is deliberate and per-session: the editor sets this only after the
 * human confirms (or types the operator password, when `_system/locks.json` asks for one), and
 * every write then carries the headers below. The server re-checks them on each request.
 */
let unlock: { active: boolean; password?: string } = { active: false };

export function setUnlock(v: { active: boolean; password?: string }): void {
  unlock = v;
}

export function isUnlocked(): boolean {
  return unlock.active;
}

async function req<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const { headers: optHeaders, ...rest } = opts;
  const res = await fetch(url, {
    credentials: 'include',
    ...rest,
    // headers MUST be merged last — spreading ...opts after a `headers` literal
    // would drop Content-Type whenever a caller passes its own headers.
    headers: {
      'Content-Type': 'application/json',
      ...(unlock.active
        ? { 'x-unlock-locked': '1', ...(unlock.password ? { 'x-unlock-password': unlock.password } : {}) }
        : {}),
      ...(optHeaders ?? {}),
    },
  });
  if (res.status === 401) {
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    let msg = res.statusText;
    let data: unknown;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
      data = body;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status, data);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : (res.text() as unknown)) as Promise<T>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: unknown) {
    super(message);
  }
}

export const api = {
  // auth
  // /auth/status is unauthenticated, so it deliberately reports nothing about
  // whether the default password is still in use. mustChangePassword comes from
  // /auth/login and /auth/me instead.
  authStatus: () => req<{ passwordSet: boolean }>('/auth/status'),
  setup: (password: string) =>
    req<{ ok: true }>('/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) =>
    req<{ ok: true; mustChangePassword: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => req<{ ok: true }>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  me: () => req<{ authenticated: boolean; mustChangePassword: boolean }>('/auth/me'),

  // files
  tree: () => req<TreeNode>('/api/files/'),
  read: (path: string) =>
    req<{
      path: string;
      content: string;
      encoding?: string;
      version?: string;
      locked?: boolean;
      lockReason?: string;
      unlock?: 'off' | 'confirm' | 'password';
    }>(`/api/files/content?path=${encodeURIComponent(path)}`),
  // baseVersion (CAS): when given, the server rejects a stale write with 409 version_conflict.
  write: (path: string, content: string, baseVersion?: string) =>
    req<{ ok: true; path: string; version?: string }>('/api/files/content', {
      method: 'PUT',
      body: JSON.stringify({ path, content, ...(baseVersion !== undefined ? { baseVersion } : {}) }),
    }),
  createFolder: (path: string) =>
    req<{ ok: true }>('/api/files/folder', { method: 'POST', body: JSON.stringify({ path }) }),
  rename: (from: string, to: string) =>
    req<{ ok: true }>('/api/files/rename', { method: 'PATCH', body: JSON.stringify({ from, to }) }),
  copy: (from: string, to: string) =>
    req<{ ok: true }>('/api/files/copy', { method: 'POST', body: JSON.stringify({ from, to }) }),
  remove: (path: string) =>
    req<{ ok: true; trashed?: string; deleted?: string }>(
      `/api/files/?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),
  // trash (FR-1)
  listTrash: () => req<{ items: TrashItem[] }>('/api/files/trash'),
  restoreTrash: (path: string) =>
    req<{ ok: true; restored: string }>('/api/files/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  deleteTrashItem: (path: string) =>
    req<{ ok: true }>(`/api/files/trash/item?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  emptyTrash: () => req<{ ok: true }>('/api/files/trash', { method: 'DELETE' }),
  uploadUrl: () => '/api/files/upload',
  upload: async (file: File, dir = 'attachments') => {
    const fd = new FormData();
    fd.append('dir', dir);
    fd.append('file', file);
    const res = await fetch('/api/files/upload', { method: 'POST', credentials: 'include', body: fd });
    if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? 'Upload failed', res.status);
    return res.json() as Promise<{ ok: true; path: string; size: number }>;
  },
  rawUrl: (path: string) => `/api/files/content?path=${encodeURIComponent(path)}`,

  // search & links
  // limit omitted → server returns every match (panel renders them incrementally)
  search: (q: string, limit?: number) =>
    req<{ hits: SearchHit[] }>(
      `/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`,
    ),
  // per-note highlighted match contexts for the given paths (lazy, batched);
  // phrase=true matches the whole query as one needle (unlinked mentions)
  searchMatches: (query: string, paths: string[], matchCase = false, phrase = false) =>
    req<{ matches: NoteMatches[] }>('/api/search/matches', {
      method: 'POST',
      body: JSON.stringify({ query, paths, matchCase, phrase }),
    }),
  tags: () => req<{ tags: { tag: string; count: number }[] }>('/api/tags'),
  properties: () =>
    req<{ properties: { key: string; type: string; count: number }[] }>('/api/properties'),
  propertyTypes: () => req<{ types: Record<string, string> }>('/api/property-types'),
  setPropertyType: (key: string, type: string) =>
    req<{ types: Record<string, string> }>('/api/property-types', {
      method: 'POST',
      body: JSON.stringify({ key, type }),
    }),
  backlinks: (path: string) =>
    req<{ backlinks: string[] }>(`/api/backlinks?path=${encodeURIComponent(path)}`),
  resolve: (target: string) =>
    req<{ path: string | null }>(`/api/resolve?target=${encodeURIComponent(target)}`),
  graph: () =>
    req<{
      nodes: { id: string; label: string; kind: 'note' | 'attachment' | 'unresolved'; tags: string[] }[];
      edges: { source: string; target: string }[];
    }>('/api/graph'),
  reindex: () => req<{ ok: true }>('/api/reindex', { method: 'POST' }),

  // tasks board (FR-15)
  tasks: (params?: TaskQuery) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value) qs.set(key, value);
    }
    const s = qs.toString();
    return req<{ tasks: TaskRecord[] }>(`/api/tasks${s ? `?${s}` : ''}`);
  },

  // ui state (workspace persistence, shared across browsers)
  getUiState: () => req<any>('/api/uistate/'),
  putUiState: (state: any, clientId: string) =>
    req<{ ok: true }>('/api/uistate/', {
      method: 'PUT',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify(state),
    }),

  // settings
  getSettings: () => req<any>('/api/settings/'),
  putSettings: (patch: any) => req<any>('/api/settings/', { method: 'PUT', body: JSON.stringify(patch) }),
  browse: (dir?: string) =>
    req<{ dir: string; parent: string; roots: string[]; folders: { name: string; path: string }[] }>(
      `/api/settings/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`,
    ),

  // git
  gitStatus: () => req<any>('/api/git/status'),
  gitInit: () => req<any>('/api/git/init', { method: 'POST' }),
  gitClone: () => req<any>('/api/git/clone', { method: 'POST' }),
  gitPull: () => req<{ message: string }>('/api/git/pull', { method: 'POST' }),
  gitCommit: (message?: string) =>
    req<{ message: string }>('/api/git/commit', { method: 'POST', body: JSON.stringify({ message }) }),
  gitPush: () => req<{ message: string }>('/api/git/push', { method: 'POST' }),
  gitSync: (message?: string) =>
    req<{ ok: boolean; log: string[] }>('/api/git/sync', { method: 'POST', body: JSON.stringify({ message }) }),
  gitLog: (path: string) =>
    req<{ commits: GitCommit[] }>(`/api/git/log?path=${encodeURIComponent(path)}`),
  gitShow: (hash: string, path: string) =>
    req<{ content: string }>(`/api/git/show?hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(path)}`),

  // api keys
  listKeys: () => req<{ keys: any[] }>('/api/keys/'),
  createKey: (name: string, scopes: string[]) =>
    req<{ key: string; record: any }>('/api/keys/', { method: 'POST', body: JSON.stringify({ name, scopes }) }),
  revokeKey: (id: string) => req<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),

  // public shares (FR-10)
  listShares: () => req<{ shares: ShareRecord[] }>('/api/shares/'),
  createShare: (path: string) =>
    req<{ share: ShareRecord }>('/api/shares/', { method: 'POST', body: JSON.stringify({ path }) }),
  setShareEnabled: (id: string, enabled: boolean) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteShare: (id: string) => req<{ ok: true }>(`/api/shares/${id}`, { method: 'DELETE' }),
  // password = null clears the share's password
  setSharePassword: (id: string, password: string | null) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ password }) }),
  // NOTE: the public-facing /share/<id> page is fully server-rendered (SSR) —
  // the SPA never fetches /public/shares/* itself.

  // plugins
  listPlugins: () => req<{ plugins: any[] }>('/api/plugins/'),
  installPlugin: (repo: string) =>
    req<{ plugin: any }>('/api/plugins/install', { method: 'POST', body: JSON.stringify({ repo }) }),
  setPluginEnabled: (id: string, enabled: boolean) =>
    req<{ ok: true }>(`/api/plugins/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
};
