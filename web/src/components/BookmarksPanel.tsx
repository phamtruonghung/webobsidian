import { useStore, type ContextMenuItem } from '../lib/store';
import { pathToUrl } from '../lib/urlsync';
import Icon from './Icon';

export default function BookmarksPanel() {
  const bookmarks = useStore((s) => s.bookmarks);
  const recent = useStore((s) => s.recent);
  const openFile = useStore((s) => s.openFile);
  const openToSide = useStore((s) => s.openToSide);
  const toggleBookmark = useStore((s) => s.toggleBookmark);
  const removeRecent = useStore((s) => s.removeRecent);
  const revealInTree = useStore((s) => s.revealInTree);
  const setMovePath = useStore((s) => s.setMovePath);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const notify = useStore((s) => s.notify);

  const name = (p: string) => p.split('/').pop()?.replace(/\.(md|markdown)$/, '') ?? p;
  // Two entries can share a file name (e.g. `a/board.md` and `b/board.md`);
  // show the parent folder next to those so they can be told apart.
  const folderHint = (p: string, list: string[]) => {
    const n = name(p);
    if (!list.some((o) => o !== p && name(o) === n)) return null;
    const dir = p.split('/').slice(0, -1).join('/');
    return <span className="panel-item-hint">{dir || '/'}</span>;
  };

  const copyUrl = (p: string) => {
    navigator.clipboard?.writeText(`${location.origin}${pathToUrl(p)}`).catch(() => {});
    notify('URL copied');
  };

  // Drag a row onto a folder in the file tree to move the underlying file
  // (FileTree's onDrop reads this same `text/wo-path` payload).
  const onDragStart = (e: React.DragEvent, path: string) => {
    e.dataTransfer.setData('text/wo-path', path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const showMenu = (e: React.MouseEvent, path: string, kind: 'bookmark' | 'recent') => {
    e.preventDefault();
    e.stopPropagation();
    const isBookmarked = bookmarks.includes(path);
    const items: ContextMenuItem[] = [
      { label: 'Open', icon: 'file-text', onClick: () => openFile(path) },
      { label: 'Open to the right', icon: 'columns', onClick: () => openToSide(path) },
      { label: '', separator: true },
      { label: 'Reveal file in navigation', icon: 'folder', onClick: () => revealInTree(path) },
      { label: 'Move file to…', icon: 'folder', onClick: () => setMovePath(path) },
      { label: isBookmarked ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', onClick: () => toggleBookmark(path) },
      ...(kind === 'recent'
        ? [{ label: 'Remove from recent', icon: 'x', onClick: () => removeRecent(path) } as ContextMenuItem]
        : []),
      { label: 'Copy URL path', onClick: () => copyUrl(path) },
    ];
    openContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const actionBtn = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div>
      <div className="panel-title">Bookmarks</div>
      {bookmarks.length === 0 && <div className="panel-item">No bookmarks yet</div>}
      {bookmarks.map((b) => (
        <div
          key={b}
          className="panel-item"
          draggable
          onDragStart={(e) => onDragStart(e, b)}
          onClick={() => openFile(b)}
          onContextMenu={(e) => showMenu(e, b, 'bookmark')}
          title={b}
        >
          <Icon name="bookmark" size={14} /> <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(b)}{folderHint(b, bookmarks)}</span>
          <span className="panel-item-actions">
            <span title="Move file to…" onClick={(e) => actionBtn(e, () => setMovePath(b))}>
              <Icon name="folder" size={13} />
            </span>
            <span title="Remove bookmark" onClick={(e) => actionBtn(e, () => toggleBookmark(b))}>
              <Icon name="x" size={13} />
            </span>
          </span>
        </div>
      ))}
      <div className="panel-title" style={{ marginTop: 8 }}>Recent</div>
      {recent.length === 0 && <div className="panel-item">No recent files</div>}
      {recent.map((r) => (
        <div
          key={r}
          className="panel-item"
          draggable
          onDragStart={(e) => onDragStart(e, r)}
          onClick={() => openFile(r)}
          onContextMenu={(e) => showMenu(e, r, 'recent')}
          title={r}
        >
          <Icon name="clock" size={14} /> <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(r)}{folderHint(r, recent)}</span>
          <span className="panel-item-actions">
            <span title="Move file to…" onClick={(e) => actionBtn(e, () => setMovePath(r))}>
              <Icon name="folder" size={13} />
            </span>
            <span title="Remove from recent" onClick={(e) => actionBtn(e, () => removeRecent(r))}>
              <Icon name="x" size={13} />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
