import { Fragment, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { findNode } from '../lib/tree';
import {
  dateStamp,
  findTemplatesFolders,
  listTemplates,
  resolveTargetFolder,
  slugify,
  uniqueNotePath,
} from '../lib/templates';

/**
 * New note from template (FR-17).
 *
 * Pick a template from the vault's `templates` folder, title the note, and it is
 * created as `<folder>/<YYYY-MM-DD>-<slug>.md` with the template's placeholders
 * filled in and opened for editing — the copy / rename / re-date step is gone.
 *
 * Choosing is explicit: **hovering does not pick a template, clicking does**
 * (the rows are buttons, so keyboard selection works too). Nothing is written
 * until the template, the title and the folder are all present, and the path the
 * note will land on is shown before that.
 */
export default function TemplatePicker() {
  const open = useStore((s) => s.templatePicker);
  // Mounted only while open, so every opening starts from a clean form without
  // a reset effect that could also fire on an unrelated tree refresh.
  if (!open) return null;
  return <Picker />;
}

function Picker() {
  const setOpen = useStore((s) => s.setTemplatePicker);
  const tree = useStore((s) => s.tree);
  const newFromTemplate = useStore((s) => s.newFromTemplate);

  const [q, setQ] = useState('');
  /** The template the human picked; '' until they do — an implicit default made
   *  a hover look like a choice and a click look like it did nothing. */
  const [chosen, setChosen] = useState('');
  /** Folder typed by hand; null = derive it from the chosen template. */
  const [typedFolder, setTypedFolder] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const templatesFolders = useMemo(() => findTemplatesFolders(tree), [tree]);
  const templates = useMemo(() => listTemplates(tree, templatesFolders), [tree, templatesFolders]);

  const sel = chosen;
  const folder = typedFolder ?? (sel ? resolveTargetFolder(tree, sel) : '');

  // No folder named `templates` anywhere in the vault: the vault has nothing to
  // pick from (the folder itself is what is missing).
  if (templatesFolders.length === 0) {
    return (
      <div className="modal-bg" onClick={() => setOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="palette-item" data-testid="templates-missing">
            No templates folder in this vault — expected a folder named <b>templates</b>.
          </div>
        </div>
      </div>
    );
  }

  const lc = q.trim().toLowerCase();
  const shown = templates.filter((t) => !lc || t.title.toLowerCase().includes(lc));

  // The folders exist but hold no markdown (a docx-only `templates` folder, for
  // instance). That is not a failed search, so it never says "No matching
  // template" — a query-shaped dead end that reads as a broken filter.
  if (templates.length === 0) {
    return (
      <div className="modal-bg" onClick={() => setOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="palette-item" data-testid="templates-empty">
            {templatesFolders.length === 1
              ? 'A templates folder exists'
              : `${templatesFolders.length} templates folders exist`}{' '}
            in this vault but none contains a markdown (.md) file — nothing to pick.
            <div className="tpl-path">
              Checked:{' '}
              {templatesFolders.map((f, i) => (
                <Fragment key={f}>
                  {i > 0 && ', '}
                  <code>{f}</code>
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const slug = slugify(title.trim());
  const dir = folder.trim();
  const date = dateStamp(new Date());
  const targetPath =
    sel && slug && dir ? uniqueNotePath(dir, `${date}-${slug}`, (p) => !!findNode(tree, p)) : '';
  const canCreate = !!sel && !!slug && !!dir && !busy;

  /** Why the note cannot be created yet — shown instead of a dead button. */
  const blocked = !sel
    ? 'Pick a template above'
    : !slug
      ? 'Type a title to name the note'
      : !dir
        ? 'No folder for this template — type one, e.g. Wiki/meetings'
        : '';

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError('');
    try {
      await newFromTemplate(sel, title, dir);
      setOpen(false);
    } catch (e: any) {
      setError(e?.message || 'Could not create the note');
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    // A focused template row is a button: Enter/Space picks it, it must not
    // also create the note.
    else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault();
      create();
    }
  };

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          className="palette-input"
          placeholder="Choose a template…"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="palette-list" data-testid="template-list">
          {shown.map((t) => (
            <button
              type="button"
              key={t.path}
              className={`palette-item tpl-item ${t.path === sel ? 'sel' : ''}`}
              data-testid="template-item"
              data-path={t.path}
              data-chosen={t.path === sel ? 'true' : 'false'}
              aria-pressed={t.path === sel}
              onClick={() => {
                setChosen(t.path);
                setTypedFolder(null);
                setError('');
              }}
            >
              <span>{t.title}</span>
              <span className="kbd">{t.path}</span>
            </button>
          ))}
          {shown.length === 0 && <div className="palette-item">No matching template</div>}
        </div>
        <div className="tpl-form">
          <div className="tpl-row">
            <span className="tpl-label">Template</span>
            <span className="tpl-chosen" data-testid="template-chosen">
              {sel || 'none chosen'}
            </span>
          </div>
          <label className="tpl-row">
            <span className="tpl-label">Title</span>
            <input
              className="text-input"
              data-testid="template-title"
              placeholder="what this note is about"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="tpl-row">
            <span className="tpl-label">Folder</span>
            <input
              className="text-input"
              data-testid="template-folder"
              placeholder="e.g. Wiki/meetings"
              value={folder}
              onChange={(e) => setTypedFolder(e.target.value)}
            />
          </label>
          <div className="tpl-path" data-testid="template-path">
            {targetPath ? (
              <>
                Creates <code>{targetPath}</code>
              </>
            ) : (
              blocked
            )}
          </div>
          {error && (
            <div className="tpl-error" data-testid="template-error">
              {error}
            </div>
          )}
          <div className="tpl-actions">
            <button className="btn" data-testid="template-create" disabled={!canCreate} onClick={create}>
              {busy ? 'Creating…' : 'Create note'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
