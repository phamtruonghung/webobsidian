// Obsidian-parity media extension sets, shared across the Live Preview editor,
// the Reading-view renderer (markdown.ts) and the direct file view (Workspace).
// Mirrors the desktop app's image/audio/video extension groups so `![[x.mp4]]`
// and opening a media file behave the same as Obsidian.
export const VIDEO_EXT_RE = /\.(mp4|webm|ogv|mov|mkv)$/i;
export const AUDIO_EXT_RE = /\.(mp3|wav|m4a|3gp|flac|ogg|oga|opus)$/i;
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;
export const PDF_EXT_RE = /\.pdf$/i;

export type MediaKind = 'video' | 'audio';

/** Media kind for an embed/file target (ignoring any `#fragment`), else null. */
export function mediaKind(target: string): MediaKind | null {
  const t = target.split('#')[0];
  if (VIDEO_EXT_RE.test(t)) return 'video';
  if (AUDIO_EXT_RE.test(t)) return 'audio';
  return null;
}

/**
 * The pane a vault file opens in (FR-21). A file whose extension is none of
 * these and is not markdown — a spreadsheet, an archive — stays `text` and falls
 * through to the editor; that limit is recorded on the issue, not accidental.
 */
export type FileViewKind = 'canvas' | 'image' | 'video' | 'audio' | 'pdf' | 'text';

export function fileViewKind(path: string): FileViewKind {
  const p = path.split('#')[0];
  if (/\.canvas$/i.test(p)) return 'canvas';
  if (IMAGE_EXT_RE.test(p)) return 'image';
  if (VIDEO_EXT_RE.test(p)) return 'video';
  if (AUDIO_EXT_RE.test(p)) return 'audio';
  if (PDF_EXT_RE.test(p)) return 'pdf';
  return 'text';
}

/**
 * True for a target the vault can only hold as a file — `[[report.pdf]]`,
 * `![[clip.mp4]]` — so the client's create-on-unresolved-link fallback must not
 * write a note named `report.pdf` because of a typo.
 */
export function isAttachmentTarget(target: string): boolean {
  const t = target.split('#')[0].trim();
  return IMAGE_EXT_RE.test(t) || VIDEO_EXT_RE.test(t) || AUDIO_EXT_RE.test(t) || PDF_EXT_RE.test(t);
}
