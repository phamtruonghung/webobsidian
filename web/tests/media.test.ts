import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileViewKind, isAttachmentTarget } from '../src/lib/media';

// FR-21: the pane a vault file opens in. One predicate shared by the file view
// (Workspace), the Reading/Preview renderer (markdown.ts) and Live Preview.

test('fileViewKind maps each extension to its pane', () => {
  assert.equal(fileViewKind('relats/raw/documents/2026-09-27-report.pdf'), 'pdf');
  assert.equal(fileViewKind('Report.PDF'), 'pdf');
  assert.equal(fileViewKind('boards/plan.canvas'), 'canvas');
  assert.equal(fileViewKind('raw/assets/board.JPG'), 'image');
  assert.equal(fileViewKind('raw/assets/board.avif'), 'image');
  assert.equal(fileViewKind('raw/assets/clip.mp4'), 'video');
  assert.equal(fileViewKind('raw/assets/song.mp3'), 'audio');
  assert.equal(fileViewKind('relats/index.md'), 'text');
  assert.equal(fileViewKind('relats/daily/2026-09-27.markdown'), 'text');
  // Not mapped (yet): a spreadsheet or an archive still falls through to the
  // editor — a known limit recorded on the issue, not an accident.
  assert.equal(fileViewKind('raw/documents/costs.xlsx'), 'text');
  assert.equal(fileViewKind('raw/documents/bundle.zip'), 'text');
});

test('a fragment does not hide the file type', () => {
  assert.equal(fileViewKind('doc.pdf#page=3'), 'pdf');
  assert.equal(fileViewKind('note.md#Heading'), 'text');
});

test('isAttachmentTarget flags paths that must never be auto-created as notes', () => {
  for (const t of ['x.pdf', 'pic.png', 'clip.mp4', 'song.mp3', 'old.jpeg', 'icon.ico']) {
    assert.equal(isAttachmentTarget(t), true, t);
  }
  for (const t of ['NewNote', 'Fresh', 'note.md', 'plan.canvas', 'table.xlsx']) {
    assert.equal(isAttachmentTarget(t), false, t);
  }
});