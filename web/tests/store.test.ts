import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ApiError, api, type TreeNode } from '../src/lib/api';
import { GRAPH_PATH, TASKS_PATH, isViewPath, useStore } from '../src/lib/store';

// Workspace persistence uses browser timers; run them deterministically in Node.
Object.defineProperty(globalThis, 'window', {
  value: {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  },
  configurable: true,
});

const state = () => useStore.getState();
const paths = () => state().tabs.map((t) => t.path);

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  useStore.setState(useStore.getInitialState(), true);
  mock.method(api, 'read', async (path: string) => ({ content: `# ${path}` }));
  mock.method(api, 'write', async () => ({ ok: true }));
  mock.method(api, 'tree', async () => ({ name: '', path: '', type: 'folder', children: [] }));
  mock.method(api, 'getUiState', async () => ({}));
  mock.method(api, 'putUiState', async () => ({ ok: true }));
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

test('browsing many notes reuses one preview tab', async () => {
  for (let i = 0; i < 25; i++) await state().openFile(`Note ${i}.md`);
  assert.deepEqual(paths(), ['Note 24.md']);
  assert.equal(state().tabs[0].preview, true);
  assert.equal(state().content, '# Note 24.md');
});

test('keeping a preview open preserves it and reuses the next preview in place', async () => {
  await state().openFile('Keep.md');
  state().keepTab('Keep.md');
  await state().openFile('Preview.md');
  await state().openGraph();
  await state().openFile('Next.md');
  assert.deepEqual(paths(), ['Keep.md', 'Next.md', GRAPH_PATH]);
  assert.equal(state().tabs[0].preview, false);
  assert.equal(state().tabs[1].preview, true);
  assert.equal(state().tabs[2].preview, undefined);

  await state().openFile('Keep.md');
  assert.deepEqual(paths(), ['Keep.md', 'Next.md', GRAPH_PATH]);
  assert.equal(state().tabs[0].preview, false);
  assert.equal(state().activePath, 'Keep.md');
});

test('editing a preview keeps it open even after saving', async () => {
  const writes = mock.method(api, 'write', async () => ({ ok: true }));
  await state().openFile('Edited.md');
  state().setContent('Local edits');
  assert.equal(state().tabs[0].preview, false);
  await state().openFile('Next.md');
  assert.deepEqual(writes.mock.calls[0].arguments, ['Edited.md', 'Local edits']);
  assert.deepEqual(paths(), ['Edited.md', 'Next.md']);
  assert.equal(state().dirty, false);
});

test('creating a note opens it permanently without replacing an existing preview', async () => {
  await state().openFile('Preview.md');
  await state().createNote('New.md', '# New');
  assert.deepEqual(paths(), ['Preview.md', 'New.md']);
  assert.equal(state().tabs[1].preview, false);
});

test('opening a missing note leaves the current preview intact', async () => {
  await state().openFile('Preview.md');
  mock.method(api, 'read', async () => { throw new Error('Not found'); });
  await assert.rejects(state().openFile('Missing.md'), /Not found/);
  assert.deepEqual(paths(), ['Preview.md']);
  assert.equal(state().activePath, 'Preview.md');
  assert.equal(state().content, '# Preview.md');
});

test('out-of-order reads cannot replace the most recently selected note', async () => {
  let finishSlow!: (value: { content: string }) => void;
  mock.method(api, 'read', (path: string) => path === 'Slow.md'
    ? new Promise<{ content: string }>((resolve) => { finishSlow = resolve; })
    : Promise.resolve({ content: '# Fast' }));
  const slow = state().openFile('Slow.md');
  await state().openFile('Fast.md');
  finishSlow({ content: '# Slow' });
  await slow;
  assert.deepEqual(paths(), ['Fast.md']);
  assert.equal(state().activePath, 'Fast.md');
  assert.equal(state().content, '# Fast');
});

test('openTasks() opens one "Tasks" tab at TASKS_PATH, and openFile(TASKS_PATH) routes to it', async () => {
  await state().openTasks();
  assert.deepEqual(paths(), [TASKS_PATH]);
  assert.equal(state().tabs[0].title, 'Tasks');
  assert.equal(state().activePath, TASKS_PATH);

  await state().openFile('Note.md');
  await state().openFile(TASKS_PATH);
  assert.deepEqual(paths(), [TASKS_PATH, 'Note.md']); // reuses the existing Tasks tab, doesn't duplicate it
  assert.equal(state().activePath, TASKS_PATH);
});

test('isViewPath is true only for the Graph/Tasks sentinel tab paths', () => {
  assert.equal(isViewPath(GRAPH_PATH), true);
  assert.equal(isViewPath(TASKS_PATH), true);
  assert.equal(isViewPath('Wiki/Note.md'), false);
  assert.equal(isViewPath(null), false);
});

test('opening Graph view cancels an older pending note selection', async () => {
  let finishRead!: (value: { content: string }) => void;
  mock.method(api, 'read', () => new Promise<{ content: string }>((resolve) => { finishRead = resolve; }));
  const pending = state().openFile('Slow.md');
  await state().openGraph();
  finishRead({ content: '# Slow' });
  await pending;
  assert.deepEqual(paths(), [GRAPH_PATH]);
  assert.equal(state().activePath, GRAPH_PATH);
});

test('edits made while the next preview loads are saved and kept open', async () => {
  await state().openFile('Edited.md');
  let finishRead!: (value: { content: string }) => void;
  mock.method(api, 'read', () => new Promise<{ content: string }>((resolve) => { finishRead = resolve; }));
  const writes = mock.method(api, 'write', async () => ({ ok: true }));
  const pending = state().openFile('Next.md');
  state().setContent('Typed while loading');
  finishRead({ content: '# Next' });
  await pending;
  assert.deepEqual(writes.mock.calls[0].arguments, ['Edited.md', 'Typed while loading']);
  assert.deepEqual(paths(), ['Edited.md', 'Next.md']);
  assert.equal(state().tabs[0].preview, false);
});

test('back and forward navigation reuse the preview without adding tabs', async () => {
  await state().openFile('First.md');
  await state().openFile('Second.md');
  state().goBack();
  await setImmediate();
  assert.deepEqual(paths(), ['First.md']);
  assert.equal(state().histIndex, 0);
  state().goForward();
  await setImmediate();
  assert.deepEqual(paths(), ['Second.md']);
  assert.deepEqual(state().history, ['First.md', 'Second.md']);
  assert.equal(state().histIndex, 1);
});

test('closing a preview allows a fresh preview without disturbing permanent tabs', async () => {
  await state().openFile('Keep.md', { preview: false });
  await state().openFile('Preview.md');
  state().closeTab('Preview.md');
  await state().openFile('Next.md');
  assert.deepEqual(paths(), ['Keep.md', 'Next.md']);
  assert.equal(state().tabs[0].preview, false);
  assert.equal(state().tabs[1].preview, true);
});

test('workspace reload preserves preview state and treats legacy tabs as permanent', async () => {
  const saved = {
    tabs: [
      { path: 'Legacy.md', title: 'Legacy.md' },
      { path: 'Preview.md', title: 'Preview.md', preview: true },
    ],
    activePath: 'Preview.md',
  };
  mock.method(api, 'getUiState', async () => saved);
  const writes = mock.method(api, 'putUiState', async () => ({ ok: true }));
  await state().loadUiState();
  await state().openFile('Next.md');
  assert.deepEqual(paths(), ['Legacy.md', 'Next.md']);
  assert.equal(state().tabs[0].preview, undefined);
  assert.equal(state().tabs[1].preview, true);
  mock.timers.tick(500);
  assert.deepEqual(writes.mock.calls.at(-1)!.arguments[0].tabs, state().tabs);

  state().keepTab('Next.md');
  mock.timers.tick(500);
  assert.equal(writes.mock.calls.at(-1)!.arguments[0].tabs[1].preview, false);
});

// ---- New note from template (FR-17) --------------------------------------

/** The vault shape the command resolves folders against. */
const VAULT_TREE: TreeNode = {
  name: '',
  path: '',
  type: 'folder',
  children: [
    {
      name: 'Wiki',
      path: 'Wiki',
      type: 'folder',
      children: [
        {
          name: 'templates',
          path: 'Wiki/templates',
          type: 'folder',
          children: [
            { name: 'meeting.md', path: 'Wiki/templates/meeting.md', type: 'file', ext: 'md' },
          ],
        },
        { name: 'meetings', path: 'Wiki/meetings', type: 'folder', children: [] },
      ],
    },
  ],
};

/** A template in both token and literal form, so both paths are exercised. */
const MEETING_TEMPLATE = [
  '---',
  'title: {{title}}',
  'created: {{date}}',
  'updated: {{date}}',
  'type: meeting',
  'date: {{date}}',
  'tags: [meeting]',
  'sources: [raw/meetings/YYYY-MM-DD-slug.md]',
  '---',
  '',
  '# {{title}}',
  '',
  '<!-- created {{time}} -->',
].join('\n');

/** Pin the clock so the dated path and the filled tokens are exact. */
const freeze = (y: number, m: number, d: number, h: number, min: number) => {
  // The file-level beforeEach already enabled the setTimeout mocks; swap in a
  // frozen clock (Date too) so the dated path and times are exact.
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  mock.timers.setTime(new Date(y, m - 1, d, h, min).getTime());
};

test('newFromTemplate creates the dated, filled note and opens it', async () => {
  freeze(2026, 9, 26, 7, 30);
  useStore.setState({ tree: VAULT_TREE });
  mock.method(api, 'tree', async () => VAULT_TREE);
  const writes = mock.method(api, 'write', async () => ({ ok: true }));
  mock.method(api, 'read', async () => ({ content: MEETING_TEMPLATE }));

  const path = await state().newFromTemplate(
    'Wiki/templates/meeting.md',
    'QMS review with Ban',
    'Wiki/meetings',
  );

  assert.equal(path, 'Wiki/meetings/2026-09-26-qms-review-with-ban.md');
  assert.equal(state().activePath, path, 'the new note is the open tab');
  assert.match(state().toast, /Created from template/);
  assert.deepEqual(writes.mock.calls[0].arguments, [
    path,
    [
      '---',
      'title: QMS review with Ban',
      'created: 2026-09-26',
      'updated: 2026-09-26',
      'type: meeting',
      'date: 2026-09-26',
      'tags: [meeting]',
      'sources: [raw/meetings/2026-09-26-qms-review-with-ban.md]',
      '---',
      '',
      '# QMS review with Ban',
      '',
      '<!-- created 07:30 -->',
    ].join('\n'),
    '', // create-only: the path must not exist yet
  ]);
});

test('newFromTemplate never overwrites — an existing same-day note moves to -2', async () => {
  freeze(2026, 9, 26, 7, 30);
  const taken = 'Wiki/meetings/2026-09-26-qms-review-with-ban.md';
  const tree: TreeNode = {
    ...VAULT_TREE,
    children: [
      {
        ...VAULT_TREE.children![0],
        children: [
          ...(VAULT_TREE.children![0].children ?? []),
          { name: '2026-09-26-qms-review-with-ban.md', path: taken, type: 'file', ext: 'md' },
        ],
      },
    ],
  };
  useStore.setState({ tree });
  mock.method(api, 'tree', async () => tree);
  const writes = mock.method(api, 'write', async () => ({ ok: true }));
  mock.method(api, 'read', async () => ({ content: MEETING_TEMPLATE }));

  const path = await state().newFromTemplate('Wiki/templates/meeting.md', 'QMS review with Ban', 'Wiki/meetings');

  assert.equal(path, 'Wiki/meetings/2026-09-26-qms-review-with-ban-2.md');
  assert.equal(writes.mock.calls[0].arguments[0], path);
});

test('newFromTemplate retries the next suffix when a concurrent writer wins the race', async () => {
  freeze(2026, 9, 26, 7, 30);
  useStore.setState({ tree: VAULT_TREE });
  mock.method(api, 'tree', async () => VAULT_TREE);
  mock.method(api, 'read', async () => ({ content: MEETING_TEMPLATE }));
  let first = true;
  const writes = mock.method(api, 'write', async (path: string) => {
    if (first) {
      first = false;
      throw new ApiError('version_conflict', 409);
    }
    return { ok: true, path };
  });

  const path = await state().newFromTemplate('Wiki/templates/meeting.md', 'QMS review with Ban', 'Wiki/meetings');

  assert.equal(path, 'Wiki/meetings/2026-09-26-qms-review-with-ban-2.md');
  assert.deepEqual(
    writes.mock.calls.map((c) => c.arguments[0]),
    ['Wiki/meetings/2026-09-26-qms-review-with-ban.md', path],
  );
});

test('newFromTemplate refuses a title that yields no filename, and writes nothing', async () => {
  useStore.setState({ tree: VAULT_TREE });
  const writes = mock.method(api, 'write', async () => ({ ok: true }));
  await assert.rejects(
    () => state().newFromTemplate('Wiki/templates/meeting.md', '   ', 'Wiki/meetings'),
    /title is required/i,
  );
  assert.equal(writes.mock.calls.length, 0);
});

test('newFromTemplate refuses a folder that does not exist, and writes nothing', async () => {
  useStore.setState({ tree: VAULT_TREE });
  const writes = mock.method(api, 'write', async () => ({ ok: true }));
  await assert.rejects(
    () => state().newFromTemplate('Wiki/templates/meeting.md', 'QMS review', 'Wiki/nope'),
    /Folder not found: Wiki\/nope/,
  );
  assert.equal(writes.mock.calls.length, 0);
});

test('newFromTemplate lets a failed template read through, writing nothing', async () => {
  useStore.setState({ tree: VAULT_TREE });
  const writes = mock.method(api, 'write', async () => ({ ok: true }));
  mock.method(api, 'read', async () => {
    throw new Error('Not found');
  });
  await assert.rejects(
    () => state().newFromTemplate('Wiki/templates/gone.md', 'QMS review', 'Wiki/meetings'),
    /Not found/,
  );
  assert.equal(writes.mock.calls.length, 0);
});
