import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { getSettings } from '../services/settings.js';
import { qmd } from '../services/search.js';
import { updateLinkGraphForFile } from '../services/links.js';
import { scheduleAutoCommitOnSave } from '../services/git.js';
import { resolveFile } from '../services/fileindex.js';
import { onFileRenamed } from '../services/shares.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';
import { contentVersion, checkVersion } from '../services/noteversion.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

// Refresh derived indexes after a mutation (best-effort, non-blocking).
// Incremental: only the touched file(s) are reparsed, not the whole vault.
function reindex(opts: { upsert?: string; added?: string; removed?: string } = {}) {
  if (opts.upsert) void qmd.upsert(opts.upsert).catch(() => {});
  if (opts.added && isMd(opts.added)) void updateLinkGraphForFile(opts.added).catch(() => {});
  if (opts.removed && isMd(opts.removed)) void updateLinkGraphForFile(opts.removed, true).catch(() => {});
  scheduleAutoCommitOnSave();
}

filesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await vault.listTree());
  }),
);

filesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    let rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    // Obsidian-style resolution: if the exact path doesn't exist (e.g. an embed
    // `![[image.jpg]]` that lives in Attachments/), resolve it by basename.
    if (!(await vault.exists(rel))) {
      const resolved = resolveFile(rel);
      if (resolved) rel = resolved;
    }
    if (vault.isTextFile(rel)) {
      const content = await vault.readFileText(rel);
      // Additive: existing clients that ignore `version` are unaffected. Used as
      // the compare-and-set base for PUT (e.g. the Tasks board's write-back).
      res.json({ path: rel, content, encoding: 'utf8', version: contentVersion(content) });
    } else {
      // Stream with Range support so embedded <video>/<audio> can seek.
      const abs = await vault.resolveInVault(rel);
      await sendFileWithRange(req, res, abs, mimeFor(rel));
    }
  }),
);

filesRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    const { path: rel, content, baseVersion } = req.body ?? {};
    if (typeof rel !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'path and content required' });
      return;
    }
    // Optimistic lock (compare-and-set), same contract as the Agent API's
    // base_version: only checked when the caller sends baseVersion — omitting
    // it keeps the old last-writer-wins autosave behaviour byte-for-byte. When
    // baseVersion IS sent, a missing file only satisfies baseVersion === '' —
    // otherwise a card move racing a delete would silently recreate the note.
    if (typeof baseVersion === 'string') {
      const exists = await vault.exists(rel);
      const check = checkVersion(exists ? await vault.readFileText(rel) : null, baseVersion);
      if (!check.ok) {
        res.status(409).json({ error: 'version_conflict', currentVersion: check.currentVersion });
        return;
      }
    }
    await vault.writeFileText(rel, content);
    reindex({ upsert: rel, added: rel });
    res.json({ ok: true, path: rel, version: contentVersion(content) });
  }),
);

filesRouter.post(
  '/folder',
  asyncHandler(async (req, res) => {
    const { path: rel } = req.body ?? {};
    if (typeof rel !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.createFolder(rel);
    res.json({ ok: true, path: rel });
  }),
);

filesRouter.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const dir = String(req.body?.dir ?? '');
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file required' });
      return;
    }
    // Reuse an existing folder that differs only in case (e.g. an Obsidian vault's
    // "Attachments") instead of creating a duplicate "attachments". See vault.ts.
    const resolvedDir = dir ? await vault.resolveDirCaseInsensitive(dir) : '';
    const rel = path.posix.join(resolvedDir, file.originalname);
    await vault.writeFileBuffer(rel, file.buffer);
    res.json({ ok: true, path: rel, size: file.size });
  }),
);

filesRouter.patch(
  '/rename',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    await vault.rename(from, to);
    await qmd.rename(from, to);
    await onFileRenamed(from, to).catch(() => {}); // keep public share links pointing at the note
    reindex({ added: to, removed: from });
    res.json({ ok: true, from, to });
  }),
);

filesRouter.post(
  '/copy',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    const copied = await vault.copy(from, to);
    for (const f of copied) {
      if (isMd(f)) {
        void qmd.upsert(f).catch(() => {});
        void updateLinkGraphForFile(f).catch(() => {});
      }
    }
    scheduleAutoCommitOnSave();
    res.json({ ok: true, from, to });
  }),
);

// --- Trash (FR-1) -----------------------------------------------------------
// Listed/mutated via dedicated /trash* routes; the plain DELETE / below either
// trashes or permanently removes depending on settings.vault.deleteMode.

filesRouter.get(
  '/trash',
  asyncHandler(async (_req, res) => {
    res.json({ items: await vault.listTrash() });
  }),
);

filesRouter.post(
  '/trash/restore',
  asyncHandler(async (req, res) => {
    const rel = String(req.body?.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const restored = await vault.restoreFromTrash(rel);
    reindex({ upsert: restored, added: restored });
    res.json({ ok: true, restored });
  }),
);

// Permanently delete one trashed item.
filesRouter.delete(
  '/trash/item',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.deleteFromTrash(rel);
    res.json({ ok: true });
  }),
);

// Empty the whole trash.
filesRouter.delete(
  '/trash',
  asyncHandler(async (_req, res) => {
    await vault.emptyTrash();
    res.json({ ok: true });
  }),
);

filesRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const s = await getSettings();
    qmd.remove(rel);
    if (s.vault.deleteMode === 'permanent') {
      await vault.remove(rel);
      reindex({ removed: rel });
      res.json({ ok: true, deleted: rel });
      return;
    }
    const dest = await vault.trash(rel);
    reindex({ removed: rel });
    res.json({ ok: true, trashed: dest });
  }),
);
