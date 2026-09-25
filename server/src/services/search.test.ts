import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.ts computes INDEX_FILE/dataDir from process.env.DATA_DIR at import time,
// so this must be set before any module that (transitively) imports '../config.js'
// is evaluated — see routes/tasks.test.ts for the same pattern.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'wo-search-data-'));
const vaultDir = mkdtempSync(path.join(os.tmpdir(), 'wo-search-vault-'));
process.env.DATA_DIR = dataDir;

const { settings } = vi.hoisted(() => ({
  settings: {
    vault: { path: '', allowedRoots: [] as string[], trash: '.trash', deleteMode: 'trash' as const, attachmentDir: 'attachments' },
    git: {
      enabled: false, remote: '', branch: 'main', token: '', authorName: 'Tester', authorEmail: 't@example.com',
      autoSync: false, autoCommitOnSave: false, intervalSec: 300, lfsPatterns: [] as string[],
    },
    search: { fuzzy: 0.2, prefix: true, indexFrontmatter: true },
    api: { keys: [] as { id: string; name: string; hash: string; prefix: string; scopes: string[]; createdAt: string; lastUsed: string | null }[], rateLimitPerMin: 120 },
    auth: { userPasswordHash: '', passwordHash: '', jwtSecret: 'x'.repeat(64) },
  },
}));
settings.vault.path = vaultDir;

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => settings),
  updateSettings: vi.fn(async (mutator: (d: typeof settings) => void) => {
    await mutator(settings);
    return settings;
  }),
}));

const taskNote = (status: string) => `---\ntitle: Sample task\ntype: task\nstatus: ${status}\n---\nBody.\n`;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('QMD tasks map survives a restart without going stale (source of truth is the vault, not the persisted index)', () => {
  it('restore() + the boot refresh reflects an on-disk edit made while the engine was not running', async () => {
    await fsp.mkdir(path.join(vaultDir, 'Wiki'), { recursive: true });
    const taskPath = 'Wiki/task.md';
    await fsp.writeFile(path.join(vaultDir, taskPath), taskNote('open'), 'utf8');

    const { QmdEngine } = await import('./search.js');

    // A normal session: build (which also persists) while the note says "open".
    const engine1 = new QmdEngine();
    await engine1.build();
    expect((await engine1.allTasks()).find((t) => t.path === taskPath)?.status).toBe('open');

    // The process goes down; the note is edited directly on disk (or a deploy's
    // git pull lands the change) — no running engine ever sees this edit, and
    // the file watcher's `ignoreInitial` means upsert() won't fire for it either.
    await fsp.writeFile(path.join(vaultDir, taskPath), taskNote('done'), 'utf8');

    // Restart: a fresh engine instance restores the persisted index (as of the
    // "open" build) ...
    const engine2 = new QmdEngine();
    const restored = await engine2.restore();
    expect(restored).toBe(true);

    // ... then the boot path refreshes the tasks map from the vault — the
    // fix under test (initSearch() calls this once after a successful restore,
    // same as buildLinkGraph()). Without it, allTasks() would still say "open".
    await engine2.refreshTasks();

    const after = await engine2.allTasks();
    expect(after.find((t) => t.path === taskPath)?.status).toBe('done');
  });

  it('an index persisted before this fix (no tasks field) is still a valid restore — refreshTasks() populates it fresh', async () => {
    const { QmdEngine } = await import('./search.js');
    const otherPath = 'Wiki/other-task.md';
    await fsp.writeFile(path.join(vaultDir, otherPath), taskNote('blocked'), 'utf8');

    const engine = new QmdEngine();
    await engine.build();

    const restored = await engine.restore();
    expect(restored).toBe(true);
    await engine.refreshTasks();
    expect((await engine.allTasks()).find((t) => t.path === otherPath)?.status).toBe('blocked');
  });
});
