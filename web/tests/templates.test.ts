import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TreeNode } from '../src/lib/api';
import {
  dateStamp,
  findTemplatesFolders,
  listTemplates,
  resolveTargetFolder,
  slugify,
  substituteTemplate,
  targetCandidates,
  timeStamp,
  uniqueNotePath,
} from '../src/lib/templates';

/** Folder/file node helpers — a tree is just nested nodes. */
const folder = (path: string, children: TreeNode[] = []): TreeNode => ({
  name: path.split('/').pop() || path,
  path,
  type: 'folder',
  children,
});
const file = (path: string, ext = 'md'): TreeNode => ({
  name: path.split('/').pop()!,
  path,
  type: 'file',
  ext,
});

/** The shape of the vault this ships against: templates in Wiki/templates. */
const vault = folder('', [
  folder('Wiki', [
    folder('Wiki/templates', [
      file('Wiki/templates/meeting.md'),
      file('Wiki/templates/daily.md'),
      file('Wiki/templates/query.md'),
      file('Wiki/templates/abnormality.md'),
      file('Wiki/templates/weekly-review.md'),
      file('Wiki/templates/shift-handover.md'),
      file('Wiki/templates/notes.txt', 'txt'),
    ]),
    folder('Wiki/meetings'),
    folder('Wiki/queries'),
    folder('Wiki/daily'),
    folder('Wiki/concepts', [folder('Wiki/concepts/templates')]),
    folder('Wiki/reviews'),
    folder('Wiki/tasks'),
  ]),
  file('templates.md'),
]);

// ---- slugify -------------------------------------------------------------

test('slugify folds Vietnamese diacritics, including đ which NFD leaves alone', () => {
  assert.equal(slugify('Kiểm tra tem mới với Ban và Chiến'), 'kiem-tra-tem-moi-voi-ban-va-chien');
  assert.equal(slugify('Đổi OPU chuẩn'), 'doi-opu-chuan');
});

test('slugify collapses punctuation and whitespace runs into single hyphens', () => {
  assert.equal(slugify('QMS Review — 2026 (Ban/Chien)'), 'qms-review-2026-ban-chien');
  assert.equal(slugify('  spaced   out  '), 'spaced-out');
  assert.equal(slugify('trailing---'), 'trailing');
});

test('slugify caps the stem so a sentence-long title cannot make an unopenable path', () => {
  const slug = slugify('a '.repeat(80));
  assert.ok(slug.length <= 60, `slug is capped at 60 chars, got ${slug.length}`);
  assert.ok(!slug.endsWith('-'), 'a capped slug never ends on a hyphen');
});

// ---- timestamps ----------------------------------------------------------

test('dateStamp/timeStamp use local time and are zero-padded', () => {
  const d = new Date(2026, 8, 6, 7, 5); // 2026-09-06 07:05 local
  assert.equal(dateStamp(d), '2026-09-06');
  assert.equal(timeStamp(d), '07:05');
});

// ---- substitution --------------------------------------------------------

test('substituteTemplate fills every token', () => {
  const out = substituteTemplate('title: {{title}}\ncreated: {{date}} {{time}} ({{slug}})', {
    title: 'QMS Review',
    date: '2026-09-26',
    time: '07:05',
    slug: 'qms-review',
  });
  assert.equal(out, 'title: QMS Review\ncreated: 2026-09-26 07:05 (qms-review)');
});

test('substituteTemplate understands the literal YYYY-MM-DD shapes the vault already writes', () => {
  const t = { title: 'QMS Review', date: '2026-09-26', time: '07:05', slug: 'qms-review' };
  // The compound token must win: a bare-date-first order would leave `-slug`
  // in this source path and the nightly filing could not find the capture.
  assert.equal(
    substituteTemplate('sources: [raw/meetings/YYYY-MM-DD-slug.md]', t),
    'sources: [raw/meetings/2026-09-26-qms-review.md]',
  );
  assert.equal(substituteTemplate('date: YYYY-MM-DD', t), 'date: 2026-09-26');
  assert.equal(
    substituteTemplate('title: Meeting — subject YYYY-MM-DD', t),
    'title: Meeting — subject 2026-09-26',
  );
});

test('substituteTemplate leaves a template with no tokens untouched', () => {
  const body = '# Plain\n\n- nothing to fill\n';
  assert.equal(substituteTemplate(body, { title: 'x', date: '2026-09-26', time: '07:05', slug: 'x' }), body);
});

// ---- templates folders (vault-wide lookup, issue #64) --------------------

/** The live vault's shape: `office-104/templates` holds no markdown at all. */
const tenMd = [
  'abnormality.md',
  'daily.md',
  'document.md',
  'meeting.md',
  'one-on-one.md',
  'procedure.md',
  'query.md',
  'shift-handover.md',
  'task.md',
  'weekly-review.md',
];
const liveVault = folder('', [
  folder('office-104', [
    folder('office-104/templates', [
      file('office-104/templates/manager-weekly-review-template-v1.docx', 'docx'),
      file('office-104/templates/manager-weekly-review-template-v1.html', 'html'),
      file('office-104/templates/manager-weekly-review-template-v1.pdf', 'pdf'),
    ]),
  ]),
  folder('relats', [folder('relats/templates', tenMd.map((n) => file(`relats/templates/${n}`)))]),
]);

test('findTemplatesFolders answers every folder named templates, shallowest first then alphabetical', () => {
  // office-104 sorts before relats — the exact order that made first-folder-wins pick the docx-only one.
  assert.deepEqual(findTemplatesFolders(liveVault), ['office-104/templates', 'relats/templates']);
  assert.deepEqual(findTemplatesFolders(vault), ['Wiki/templates', 'Wiki/concepts/templates']);
  assert.deepEqual(
    findTemplatesFolders(folder('', [folder('templates'), folder('Wiki', [folder('Wiki/templates')])])),
    ['templates', 'Wiki/templates'],
  );
  assert.deepEqual(findTemplatesFolders(folder('', [folder('Vault', [folder('Vault/Templates')])])), [
    'Vault/Templates',
  ]);
  assert.deepEqual(findTemplatesFolders(null), []);
});

test('findTemplatesFolders returns [] when there is none — a file named templates.md is not one', () => {
  assert.deepEqual(findTemplatesFolders(vault.children![1] as TreeNode | null), []);
  assert.deepEqual(findTemplatesFolders(folder('', [file('templates.md')])), []);
});

test('the md-less office-104/templates cannot shadow relats/templates: all 10 markdown templates list', () => {
  const folders = findTemplatesFolders(liveVault);
  assert.deepEqual(folders, ['office-104/templates', 'relats/templates']);
  assert.deepEqual(
    listTemplates(liveVault, folders).map((t) => t.path),
    tenMd.map((n) => `relats/templates/${n}`),
  );
});

test('two md-bearing template folders list the union, de-duplicated by path, alphabetical by title', () => {
  const both = folder('', [
    folder('a', [folder('a/templates', [file('a/templates/meeting.md'), file('a/templates/daily.md')])]),
    folder('b', [folder('b/templates', [file('b/templates/weekly-review.md'), file('b/templates/meeting.md')])]),
  ]);
  const folders = findTemplatesFolders(both);
  const listed = listTemplates(both, folders);
  assert.deepEqual(
    listed.map((t) => t.path),
    [
      'a/templates/daily.md',
      'a/templates/meeting.md',
      'b/templates/meeting.md',
      'b/templates/weekly-review.md',
    ],
  );
  // The same folder handed in twice is still one row per path.
  assert.equal(listTemplates(both, [...folders, 'a/templates']).length, listed.length);
});

test('duplicate basenames stay distinguishable — each row keeps its own path', () => {
  const dup = folder('', [
    folder('a', [folder('a/templates', [file('a/templates/note.md')])]),
    folder('b', [folder('b/templates', [file('b/templates/note.md')])]),
  ]);
  const listed = listTemplates(dup, findTemplatesFolders(dup));
  assert.deepEqual(
    listed.map((t) => t.title),
    ['note', 'note'],
  );
  assert.deepEqual(
    listed.map((t) => t.path),
    ['a/templates/note.md', 'b/templates/note.md'],
  );
});

test('no templates folder anywhere → [] (the vault has none, not the query missing)', () => {
  assert.deepEqual(findTemplatesFolders(folder('', [folder('relats', [folder('relats/notes')])])), []);
  assert.deepEqual(listTemplates(vault, []), []);
  assert.deepEqual(listTemplates(liveVault, []), []);
  assert.deepEqual(listTemplates(liveVault, ['relats/nope']), []);
});

test('listTemplates keeps markdown-only, alphabetical, other extensions ignored', () => {
  assert.deepEqual(listTemplates(vault, ['Wiki/templates']).map((t) => t.title), [
    'abnormality',
    'daily',
    'meeting',
    'query',
    'shift-handover',
    'weekly-review',
  ]);
  assert.deepEqual(listTemplates(vault, ['Wiki/nope']), []);
});

// ---- target folder -------------------------------------------------------

test('targetCandidates pluralises then falls back to the name as written', () => {
  assert.deepEqual(targetCandidates('meeting'), ['meetings', 'meeting']);
  assert.deepEqual(targetCandidates('query'), ['queries', 'query']);
  assert.deepEqual(targetCandidates('abnormality'), ['abnormalities', 'abnormality']);
  assert.deepEqual(targetCandidates('daily'), ['dailies', 'daily']);
  assert.deepEqual(targetCandidates('weekly-review'), ['weekly-reviews', 'weekly-review', 'reviews', 'review']);
});

test('resolveTargetFolder finds the sibling folder each template belongs to', () => {
  assert.equal(resolveTargetFolder(vault, 'Wiki/templates/meeting.md'), 'Wiki/meetings');
  assert.equal(resolveTargetFolder(vault, 'Wiki/templates/query.md'), 'Wiki/queries');
  assert.equal(resolveTargetFolder(vault, 'Wiki/templates/daily.md'), 'Wiki/daily');
  assert.equal(resolveTargetFolder(vault, 'Wiki/templates/weekly-review.md'), 'Wiki/reviews');
});

test('resolveTargetFolder returns "" when the vault has no folder for the template', () => {
  // shift-handover → shift-handovers/handover(s): nothing in the tree matches.
  assert.equal(resolveTargetFolder(vault, 'Wiki/templates/shift-handover.md'), '');
});

test('resolveTargetFolder does not mistake a nested folder for a sibling', () => {
  // Wiki/concepts/templates exists, but meeting.md's target must be searched
  // among Wiki/'s children only.
  assert.equal(resolveTargetFolder(vault, 'Wiki/templates/meeting.md'), 'Wiki/meetings');
});

test('resolveTargetFolder derives from the template’s own parent — office-104 never aims into relats/', () => {
  // relats/ really holds a `meetings` folder, so a parent-agnostic lookup would
  // happily send an office-104 template's note there (issue #64).
  const two = folder('', [
    folder('office-104', [
      folder('office-104/templates', [file('office-104/templates/meeting.md')]),
    ]),
    folder('relats', [
      folder('relats/meetings'),
      folder('relats/templates', [file('relats/templates/meeting.md')]),
    ]),
  ]);
  assert.equal(resolveTargetFolder(two, 'office-104/templates/meeting.md'), '');
  assert.equal(resolveTargetFolder(two, 'relats/templates/meeting.md'), 'relats/meetings');
  // The live shape: the md-less office-104 folder resolves nothing at all, and
  // nothing it returns can be under relats/.
  for (const tpl of ['x.md', 'meeting.md', 'manager-weekly-review-template-v1.md']) {
    const hit = resolveTargetFolder(liveVault, `office-104/templates/${tpl}`);
    assert.equal(hit, '', `office-104/templates/${tpl} must not resolve (got "${hit}")`);
    assert.ok(!hit.startsWith('relats'), `never into relats/ (got "${hit}")`);
  }
});

// ---- unique path ---------------------------------------------------------

test('uniqueNotePath appends -2, -3 … and never overwrites', () => {
  const taken = new Set<string>();
  const exists = (p: string) => taken.has(p);
  assert.equal(uniqueNotePath('Wiki/meetings', '2026-09-26-qms-review', exists), 'Wiki/meetings/2026-09-26-qms-review.md');
  taken.add('Wiki/meetings/2026-09-26-qms-review.md');
  assert.equal(uniqueNotePath('Wiki/meetings', '2026-09-26-qms-review', exists), 'Wiki/meetings/2026-09-26-qms-review-2.md');
  taken.add('Wiki/meetings/2026-09-26-qms-review-2.md');
  assert.equal(uniqueNotePath('Wiki/meetings', '2026-09-26-qms-review', exists), 'Wiki/meetings/2026-09-26-qms-review-3.md');
});

test('uniqueNotePath joins without a leading slash at the vault root', () => {
  assert.equal(uniqueNotePath('', '2026-09-26-note', () => false), '2026-09-26-note.md');
});
