import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { findNode } from '../lib/tree';
import {
  dateStamp,
  findTemplatesFolder,
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
 * The title is what names the file, so the path the note will land on is shown
 * before anything is written.
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
  /** Template chosen explicitly; '' = use the first one in the folder. */
  const [chosen, setChosen] = useState('');
  /** Folder typed by hand; null = derive it from the template. */
  const [typedFolder, setTypedFolder] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const templatesFolder = useMemo(() => findTemplatesFolder(tree), [tree]);
  const templates = useMemo(() => listTemplates(tree, templatesFolder), [tree, templatesFolder]);

  const sel = chosen || templates[0]?.path || '';
  const folder = typedFolder ?? resolveTargetFolder(tree, sel);

  if (templatesFolder === null) {
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
  const slug = slugify(title.trim());
  const date = dateStamp(new Date());
  const targetPath = slug
    ? uniqueNotePath(folder, `${date}-${slug}`, (p) => !!findNode(tree, p))
    : '';
  const canCreate = !!sel && !!slug && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError('');
    try {
      await newFromTemplate(sel, title, folder);
      setOpen(false);
    } catch (e: any) {
      setError(e?.message || 'Could not create the note');
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'Enter') {
      e.preventDefault();
      create();
    }
  };

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          className="palette-input"
          placeholder="New note from template…"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="palette-list" data-testid="template-list">
          {shown.map((t) => (
            <div
              key={t.path}
              className={`palette-item ${t.path === sel ? 'sel' : ''}`}
              data-testid="template-item"
              data-path={t.path}
              onMouseEnter={() => setChosen(t.path)}
              onClick={() => {
                setChosen(t.path);
                setTypedFolder(null);
                setError('');
              }}
            >
              <span>{t.title}</span>
              <span className="kbd">{t.path}</span>
            </div>
          ))}
          {shown.length === 0 && <div className="palette-item">No matching template</div>}
        </div>
        <div className="tpl-form">
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
              <>Creates <code>{targetPath}</code></>
            ) : (
              'Type a title to name the note'
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
