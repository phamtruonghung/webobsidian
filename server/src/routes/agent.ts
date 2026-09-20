import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireApiKey } from '../middleware/apikey.js';
import * as vault from '../services/vault.js';
import { qmd } from '../services/search.js';
import { backlinksFor, buildLinkGraph } from '../services/links.js';
import { parseNote } from '../services/markdown.js';
import { applyEdit } from '../services/noteedit.js';
import { contentVersion } from '../services/noteversion.js';
import { grepNote } from '../services/notegrep.js';

/**
 * Agent API (PRD FR-6) — REST surface for AI agents, authenticated by API key.
 * All note paths are vault-relative. Scopes: read / write / search.
 *
 * The read-modify-write surface (segmented read + `version`/`base_version`, atomic
 * find/replace, `/note-matches`) is adopted from the fork `blueberry6401/webobsidian`;
 * see docs/UPSTREAM_PR_MERGES.md → "Adopted from other forks".
 */
export const agentRouter = Router();

function reindex(rel?: string) {
  if (rel) void qmd.upsert(rel).catch(() => {});
  void buildLinkGraph().catch(() => {});
}

/** Strict mode: refuse a write that does not carry `base_version` (see docs/AGENT_API.md). */
function requireVersion(): boolean {
  const raw = (process.env.WEBOBSIDIAN_AGENT_REQUIRE_VERSION ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function hasField(obj: unknown, key: string): boolean {
  return typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

agentRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'webobsidian-agent-api', version: 'v1' }));

// List notes
agentRouter.get(
  '/notes',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    // The caller picks the order. Default = most recently modified first, so a note the
    // agent just wrote never falls past `limit` into an unread tail.
    const sort: vault.NoteSort =
      req.query.sort === 'name' || req.query.sort === 'created' ? req.query.sort : 'modified';
    const order: vault.SortOrder =
      req.query.order === 'asc' || req.query.order === 'desc'
        ? req.query.order
        : sort === 'name'
          ? 'asc'
          : 'desc';
    const all = await vault.listMarkdownFilesSorted(sort, order);
    // `folder` narrows to a subtree (handy for filing: list everything under Wiki/tasks).
    const folder = String(req.query.folder ?? '').replace(/^\/+|\/+$/g, '');
    const filtered = folder ? all.filter((p) => p === folder || p.startsWith(folder + '/')) : all;
    const offset = Number(req.query.offset ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    res.json({
      total: filtered.length,
      offset,
      limit,
      sort,
      order,
      folder: folder || undefined,
      notes: filtered.slice(offset, offset + limit),
    });
  }),
);

// Read a note (path can contain slashes)
agentRouter.get(
  '/notes/*',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const content = await vault.readFileText(rel);
    const note = parseNote(rel, content);
    const version = contentVersion(content);

    // Segmented read: `limit` pages the note by lines so an agent can edit a 5k-line note
    // without pulling all of it into its context. Omitted `limit` returns the whole note
    // (the pre-existing behaviour — no silent truncation for existing clients).
    const lines = content.split('\n');
    const totalLines = lines.length;
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const rawLimit = Number(req.query.limit ?? 0) || 0;
    const limit = rawLimit > 0 ? Math.min(rawLimit, 2000) : totalLines;
    const slice = lines.slice(offset, offset + limit).join('\n');

    res.json({
      path: rel,
      content: slice,
      version,
      totalLines,
      offset,
      limit,
      hasMore: offset + limit < totalLines,
      title: note.title,
      frontmatter: note.frontmatter,
      tags: note.tags,
      links: note.links,
    });
  }),
);

// Create / update a note
agentRouter.put(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const baseVersion = req.body?.base_version;

    // Optimistic lock. Sending `base_version` makes the write safe against a concurrent
    // edit ("" for a note that must not exist yet); omitting it keeps the old
    // last-writer-wins behaviour unless WEBOBSIDIAN_AGENT_REQUIRE_VERSION is set.
    if (typeof baseVersion === 'string') {
      const existed = await vault.exists(rel);
      if (existed) {
        const current = contentVersion(await vault.readFileText(rel));
        if (baseVersion !== current) {
          res.status(409).json({ error: 'version_conflict', currentVersion: current });
          return;
        }
      } else if (baseVersion !== '') {
        res.status(409).json({ error: 'version_conflict', currentVersion: '' });
        return;
      }
    } else if (requireVersion()) {
      res.status(400).json({ error: 'missing_base_version' });
      return;
    }

    await vault.writeFileText(rel, content);
    reindex(rel);
    res.json({ ok: true, path: rel, version: contentVersion(content) });
  }),
);

// PATCH: append (creates if missing) OR atomic literal find/replace.
// A body with a `find` field takes the edit branch; without it the append behaviour is
// unchanged, byte for byte.
agentRouter.patch(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    const body: unknown = req.body;

    if (hasField(body, 'find')) {
      const { find, replace, replaceAll, base_version: baseVersion } = body as {
        find: unknown;
        replace: unknown;
        replaceAll?: unknown;
        base_version?: unknown;
      };
      if (hasField(body, 'append') || typeof find !== 'string' || find === '' || typeof replace !== 'string') {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      if (!(await vault.exists(rel))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const content = await vault.readFileText(rel);
      if (typeof baseVersion === 'string' && baseVersion !== contentVersion(content)) {
        res.status(409).json({ error: 'version_conflict', currentVersion: contentVersion(content) });
        return;
      }
      const result = applyEdit(content, find, replace, replaceAll === true);
      if ('error' in result) {
        res
          .status(409)
          .json(result.error === 'find_ambiguous' ? { error: result.error, count: result.count } : { error: result.error });
        return;
      }
      await vault.writeFileText(rel, result.content);
      reindex(rel);
      res.json({ ok: true, path: rel, replaced: result.replaced, version: contentVersion(result.content) });
      return;
    }

    // Append branch — unchanged behaviour.
    const append = typeof req.body?.append === 'string' ? req.body.append : '';
    const existing = (await vault.exists(rel)) ? await vault.readFileText(rel) : '';
    const joined = existing && !existing.endsWith('\n') ? existing + '\n' + append : existing + append;
    await vault.writeFileText(rel, joined);
    reindex(rel);
    res.json({ ok: true, path: rel, size: joined.length, version: contentVersion(joined) });
  }),
);

// Delete a note (to trash)
agentRouter.delete(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const trashed = await vault.trash(rel);
    qmd.remove(rel);
    reindex();
    res.json({ ok: true, trashed });
  }),
);

// Literal grep inside one note: every occurrence with its line number (+ optional context).
// Query params (not a wildcard path) like /backlinks, to stay clear of the /notes/* order.
agentRouter.get(
  '/note-matches',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    const q = String(req.query.q ?? '');
    if (!q) {
      res.status(400).json({ error: 'missing_query' });
      return;
    }
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const caseSensitive = req.query.case_sensitive === 'true' || req.query.case_sensitive === '1';
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const context = Math.min(Number(req.query.context ?? 0) || 0, 5);
    const content = await vault.readFileText(rel);
    const result = grepNote(content, q, { caseSensitive, maxMatches: limit, context });
    res.json({
      path: rel,
      query: q,
      caseSensitive,
      count: result.count,
      truncated: result.truncated,
      matches: result.matches,
    });
  }),
);

// Search
agentRouter.get(
  '/search',
  requireApiKey('search'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    res.json({ query: q, hits: await qmd.search(q, limit) });
  }),
);

// Backlinks
agentRouter.get(
  '/backlinks',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    res.json({ path: rel, backlinks: backlinksFor(rel) });
  }),
);

// Tags
agentRouter.get(
  '/tags',
  requireApiKey('read'),
  asyncHandler(async (_req, res) => {
    res.json({ tags: qmd.allTags() });
  }),
);
