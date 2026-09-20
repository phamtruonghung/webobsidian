import { createHash } from 'node:crypto';

/**
 * Content version for the Agent API's optimistic lock (`base_version`).
 *
 * Deterministic over the UTF-8 bytes of the content — deliberately NOT mtime-based:
 * git autosync and the file watcher rewrite mtimes, so an mtime lock would report
 * false conflicts. The first 16 hex chars of the SHA-256 are plenty to detect a
 * concurrent edit in a personal vault and stay short enough to pass around in a
 * response body or a prompt.
 *
 * Adopted from the fork `blueberry6401/webobsidian` (their `services/noteversion.ts`);
 * see docs/UPSTREAM_PR_MERGES.md → "Adopted from other forks".
 */
export function contentVersion(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}
