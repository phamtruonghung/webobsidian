import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting } from '@codemirror/language';
import { obsidianHighlightStyle } from '../lib/highlight';
import { useStore } from '../lib/store';
import type { TreeNode } from '../lib/api';
import { obsidianKeymap } from '../lib/editorCommands';
import Icon from './Icon';
import { suggesterPlugin, setLinkSuggestFiles, setTagSuggestTags } from '../lib/suggest';
import {
  livePreviewPlugin,
  livePreviewState,
  livePreviewTheme,
  frontmatterField,
  tableField,
  htmlBlockField,
  mermaidField,
  htmlRenderedState,
  htmlPreviewField,
  calloutFoldState,
  calloutFoldDeco,
  noteTitleField,
  inlineTitleField,
  editorClickFix,
  mediaLoadRemeasure,
  livePreviewGeometryGuard,
  livePreviewReadonly,
  setLivePreviewReadonly,
  setLivePreviewEnabled,
  setLivePreviewLinkHandler,
  setLivePreviewMenuHandler,
  setLivePreviewNoteEmbedProvider,
  setLivePreviewPropertyProvider,
  setLivePreviewPropertyTypes,
  setLivePreviewPropertyTypeSetter,
  setLivePreviewTagProvider,
  setNoteTitle,
} from '../lib/livePreview';
import { renderMarkdown } from '../lib/markdown';
import { setActiveEditor } from '../lib/activeEditor';
import { api } from '../lib/api';

const titleOf = (path: string | null) =>
  path ? (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '') : '';

// Reading mode = the same Live Preview editor, made read-only via this compartment.
const readonlyExt = (reading: boolean) =>
  reading ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : [];

/** A locked note is read-only for the same reason a reading pane is: no keystrokes land in it. */
const isReadonly = (viewMode: string, locked: boolean) => viewMode === 'reading' || locked;

export default function Editor() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readonlyComp = useRef(new Compartment()).current;
  const applyingExternal = useRef(false);
  const activePath = useStore((s) => s.activePath);
  const content = useStore((s) => s.content);
  const setContent = useStore((s) => s.setContent);
  const save = useStore((s) => s.save);
  const viewMode = useStore((s) => s.viewMode);
  const locked = useStore((s) => s.locked);
  const lockReason = useStore((s) => s.lockReason);
  const unlockMode = useStore((s) => s.unlockMode);
  const unlockLocked = useStore((s) => s.unlockLocked);
  const showInlineTitle = useStore((s) => s.showInlineTitle);
  const openWikilink = useStore((s) => s.openWikilink);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const setLeftPanel = useStore((s) => s.setLeftPanel);
  const tree = useStore((s) => s.tree);

  useEffect(() => {
    setLivePreviewLinkHandler(openWikilink);
  }, [openWikilink]);

  useEffect(() => {
    setLivePreviewMenuHandler(openContextMenu);
    setLivePreviewPropertyProvider(() => api.properties().then((r) => r.properties).catch(() => []));
    setLivePreviewTagProvider(() => api.tags().then((r) => r.tags.map((t) => t.tag)).catch(() => []));
    // ![[note]] transclusion: resolve + render with the same pipeline as Reading.
    const resolveEmbed = async (target: string) => {
      try {
        const { path } = await api.resolve(target);
        if (!path) return null;
        const r = await api.read(path);
        return { path, content: typeof r === 'string' ? r : r.content };
      } catch {
        return null;
      }
    };
    setLivePreviewNoteEmbedProvider(async (target) => {
      const note = await resolveEmbed(target.split('#')[0].trim());
      if (!note) return null;
      const stripped = note.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      const html = await renderMarkdown(stripped, { rawUrl: (p) => api.rawUrl(p), resolveEmbed });
      return { html };
    });
  }, [openContextMenu]);

  // Feed the `[[` link suggester (vault file paths) and the `#` tag suggester.
  useEffect(() => {
    const files: string[] = [];
    const walk = (n: TreeNode) => {
      if (n.type === 'file') files.push(n.path);
      n.children?.forEach(walk);
    };
    if (tree) walk(tree);
    setLinkSuggestFiles(() => files);
  }, [tree]);
  useEffect(() => {
    let tags: string[] = [];
    api
      .tags()
      .then((r) => {
        tags = r.tags.map((t) => t.tag.replace(/^#/, ''));
      })
      .catch(() => {});
    setTagSuggestTags(() => tags);
  }, [activePath]);

  // Load the vault's property type registry (.obsidian/types.json) once.
  useEffect(() => {
    setLivePreviewPropertyTypeSetter((key, type) => api.setPropertyType(key, type).then((r) => r.types));
    api
      .propertyTypes()
      .then((r) => {
        setLivePreviewPropertyTypes(r.types);
        const v = view.current;
        if (v) v.dispatch({ effects: setLivePreviewEnabled.of(v.state.field(livePreviewState)) });
      })
      .catch(() => {});
  }, []);

  // --- editor formatting actions (used by the right-click menu) ---
  const wrap = (before: string, after = before) => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to);
    v.dispatch({
      changes: { from, to, insert: before + sel + after },
      selection: { anchor: from + before.length, head: from + before.length + sel.length },
    });
    v.focus();
  };
  const prefixLines = (prefix: string) => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const a = v.state.doc.lineAt(from).number;
    const b = v.state.doc.lineAt(to).number;
    const changes = [];
    for (let n = a; n <= b; n++) changes.push({ from: v.state.doc.line(n).from, insert: prefix });
    v.dispatch({ changes });
    v.focus();
  };
  const insert = (text: string, caretOffset = text.length) => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + caretOffset } });
    v.focus();
  };
  const copy = async () => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    await navigator.clipboard.writeText(v.state.sliceDoc(from, to)).catch(() => {});
  };
  const cut = async () => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    await navigator.clipboard.writeText(v.state.sliceDoc(from, to)).catch(() => {});
    v.dispatch({ changes: { from, to, insert: '' } });
    v.focus();
  };
  const paste = async () => {
    const t = await navigator.clipboard.readText().catch(() => '');
    if (t) insert(t);
  };
  const selectAll = () => {
    const v = view.current;
    if (v) v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const v = view.current;
    const sel = v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : '';
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Format', icon: 'pencil', submenu: [
            { label: 'Bold', onClick: () => wrap('**') },
            { label: 'Italic', onClick: () => wrap('*') },
            { label: 'Strikethrough', onClick: () => wrap('~~') },
            { label: 'Highlight', onClick: () => wrap('==') },
            { label: 'Inline code', onClick: () => wrap('`') },
          ],
        },
        {
          label: 'Paragraph', icon: 'file-text', submenu: [
            { label: 'Heading 1', onClick: () => prefixLines('# ') },
            { label: 'Heading 2', onClick: () => prefixLines('## ') },
            { label: 'Heading 3', onClick: () => prefixLines('### ') },
            { label: 'Bullet list', onClick: () => prefixLines('- ') },
            { label: 'Numbered list', onClick: () => prefixLines('1. ') },
            { label: 'Task list', onClick: () => prefixLines('- [ ] ') },
            { label: 'Quote', onClick: () => prefixLines('> ') },
            { label: 'Code block', onClick: () => wrap('```\n', '\n```') },
          ],
        },
        {
          label: 'Insert', icon: 'plus', submenu: [
            { label: 'Internal link', onClick: () => insert('[[]]', 2) },
            { label: 'External link', onClick: () => wrap('[', '](url)') },
            { label: 'Embed file', onClick: () => insert('![[]]', 3) },
            { label: 'Callout', onClick: () => insert('> [!note] Title\n> ', 18) },
            { label: 'Table', onClick: () => insert('\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n') },
            { label: 'Horizontal rule', onClick: () => insert('\n---\n') },
            { label: 'Tag', onClick: () => insert('#') },
          ],
        },
        { label: '', separator: true },
        { label: 'Cut', onClick: cut },
        { label: 'Copy', onClick: copy },
        { label: 'Paste', onClick: paste },
        { label: 'Select all', onClick: selectAll },
        ...(sel
          ? [
              { label: '', separator: true },
              { label: `Search for “${sel.slice(0, 24)}”`, icon: 'search', onClick: () => setLeftPanel('search') },
            ]
          : []),
      ],
    });
  };

  // (Re)create the view when the active file changes.
  useEffect(() => {
    if (!host.current) return;
    view.current?.destroy();

    const isMd = activePath ? /\.(md|markdown)$/i.test(activePath) : false;
    // Place the caret after the frontmatter so Properties render immediately.
    const fmMatch = isMd ? content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/) : null;
    const initPos = Math.min(fmMatch ? fmMatch[0].length : 0, content.length);
    const state = EditorState.create({
      doc: content,
      selection: { anchor: initPos },
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        // Obsidian default hotkeys (§4) win over CodeMirror's defaults.
        Prec.high(
          keymap.of(
            obsidianKeymap({
              openLink: (t) => void openWikilink(t),
              togglePreview: () =>
                useStore.getState().setViewMode(useStore.getState().viewMode === 'reading' ? 'live' : 'reading'),
              save: () => void useStore.getState().save(),
            }),
          ),
        ),
        // In-document Find/Replace (⌘F / ⌘⇧F open the panel; ⌘G next).
        search({ top: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        // GFM base so Strikethrough/Table/TaskList nodes exist (Obsidian dialect);
        // codeLanguages lazy-loads grammars for fenced blocks (Obsidian: Prism).
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        suggesterPlugin,
        // Obsidian token palette via CSS vars (works in both themes); markdown
        // structure styling is owned by the Live Preview decorations.
        syntaxHighlighting(obsidianHighlightStyle),
        EditorView.lineWrapping,
        // Live Preview drives BOTH live and reading; reading is just read-only.
        livePreviewState.init(() => isMd && viewMode !== 'source'),
        livePreviewReadonly.init(() => viewMode === 'reading'),
        readonlyComp.of(readonlyExt(isReadonly(viewMode, locked))),
        noteTitleField.init(() => titleOf(activePath)),
        inlineTitleField,
        frontmatterField,
        tableField,
        htmlBlockField,
        mermaidField,
        htmlRenderedState,
        htmlPreviewField,
        calloutFoldState,
        calloutFoldDeco,
        livePreviewPlugin,
        livePreviewTheme,
        editorClickFix,
        mediaLoadRemeasure,
        livePreviewGeometryGuard,
        EditorView.updateListener.of((u) => {
          // Ignore doc changes we applied programmatically (external content sync)
          if (u.docChanged && !applyingExternal.current) setContent(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    setActiveEditor(v);
    v.focus();
    return () => {
      setActiveEditor(null);
      v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // Sync the editor doc when `content` changes from OUTSIDE the editor — e.g. the
  // active note's content arrives asynchronously after reload/hydrate, or is
  // pushed by cross-tab sync. (User typing changes content too, but then the doc
  // already equals content, so this is a no-op.)
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === content) return;
    applyingExternal.current = true;
    const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
    const initPos = Math.min(fmMatch ? fmMatch[0].length : 0, content.length);
    v.dispatch({
      changes: { from: 0, to: current.length, insert: content },
      selection: { anchor: initPos },
    });
    applyingExternal.current = false;
  }, [content]);

  // Toggle live preview / readonly when the view mode changes (no recreate).
  useEffect(() => {
    const isMd = activePath ? /\.(md|markdown)$/i.test(activePath) : false;
    view.current?.dispatch({
      effects: [
        setLivePreviewEnabled.of(isMd && viewMode !== 'source'),
        setLivePreviewReadonly.of(isReadonly(viewMode, locked)),
        readonlyComp.reconfigure(readonlyExt(isReadonly(viewMode, locked))),
        setNoteTitle.of(showInlineTitle ? titleOf(activePath) : ''),
      ],
    });
  }, [viewMode, activePath, showInlineTitle]);

  // Debounced autosave.
  useEffect(() => {
    const id = window.setTimeout(() => save(), 900);
    return () => window.clearTimeout(id);
  }, [content, save]);

  // Obsidian DOM contract (§20): markdown-source-view.cm-s-obsidian.mod-cm6
  // + .is-live-preview when Live Preview is on; readable line length caps width.
  const cls = [
    'cm-host',
    'markdown-source-view',
    'cm-s-obsidian',
    'mod-cm6',
    'is-readable-line-width',
    viewMode !== 'source' ? 'is-live-preview live-preview' : '',
    viewMode === 'reading' ? 'is-reading-mode' : '',
    locked ? 'is-locked-note' : '',
  ].join(' ');
  return (
    <>
      {locked && activePath && (
        <LockBanner reason={lockReason} mode={unlockMode} onUnlock={unlockLocked} />
      )}
      <div className={cls} ref={host} onContextMenu={onContextMenu} />
    </>
  );
}

/**
 * The read-only banner: a locked note says who owns it, why, and how to get a change made.
 * The unlock affordance appears only when `_system/locks.json` allows one at all.
 */
function LockBanner({
  reason,
  mode,
  onUnlock,
}: {
  reason: string | null;
  mode: 'off' | 'confirm' | 'password';
  onUnlock: (password?: string) => void;
}) {
  const [pw, setPw] = useState('');
  return (
    <div className="lock-banner" role="status">
      <Icon name="lock" size={13} />
      <span className="lock-msg">
        <strong>Read-only.</strong> {reason ?? 'This note is maintained by the agent.'}
      </span>
      {mode !== 'off' && (
        <span className="lock-actions">
          {mode === 'password' ? (
            <>
              <input
                type="password"
                value={pw}
                placeholder="password"
                aria-label="unlock password"
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onUnlock(pw); }}
              />
              <button type="button" onClick={() => onUnlock(pw)}>Unlock</button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (
                  confirm(
                    'Edit this note anyway? The agent maintains it and will keep writing to it — your change can be overwritten.',
                  )
                ) {
                  onUnlock();
                }
              }}
            >
              Edit anyway
            </button>
          )}
        </span>
      )}
    </div>
  );
}
