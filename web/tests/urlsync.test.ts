import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GRAPH_PATH, TASKS_PATH, useStore } from '../src/lib/store';
import { initUrlSync, pathToUrl, urlToPath } from '../src/lib/urlsync';

// pathToUrl/urlToPath are pure (initUrlSync is the only part that touches
// `window`), so they're testable directly under node without a DOM.

test('pathToUrl', () => {
  assert.equal(pathToUrl(null), '/');
  assert.equal(pathToUrl(GRAPH_PATH), '/graph');
  assert.equal(pathToUrl(TASKS_PATH), '/tasks');
  assert.equal(pathToUrl('Wiki/My Note.md'), '/note/Wiki/My%20Note.md');
});

test('urlToPath', () => {
  assert.equal(urlToPath('/graph'), GRAPH_PATH);
  assert.equal(urlToPath('/tasks'), TASKS_PATH);
  assert.equal(urlToPath('/note/Wiki/My%20Note.md'), 'Wiki/My Note.md');
  assert.equal(urlToPath('/'), null);
});

test('pathToUrl/urlToPath round-trip for the Tasks board', () => {
  assert.equal(urlToPath(pathToUrl(TASKS_PATH)), TASKS_PATH);
});

// initUrlSync's store→URL sync compares window.location.pathname (no query
// string) against pathToUrl(activePath) (also just a pathname) and returns
// early when they already match — e.g. `/tasks?mode=board` navigating within
// the Tasks board shouldn't have its `?mode=board` query string clobbered by
// a redundant replaceState('/tasks'). A minimal window polyfill (no DOM) is
// enough to exercise this, since initUrlSync only touches window.location/history.
test('store→URL sync does not clobber an existing query string once the pathname already matches', () => {
  const win = {
    location: { pathname: '/tasks', search: '?mode=board' },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        const [p, q] = url.split('?');
        win.location.pathname = p;
        win.location.search = q ? `?${q}` : '';
      },
      pushState: (_state: unknown, _title: string, url: string) => {
        const [p, q] = url.split('?');
        win.location.pathname = p;
        win.location.search = q ? `?${q}` : '';
      },
    },
    addEventListener: () => {},
  };
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });

  useStore.setState({ activePath: null });
  initUrlSync();
  useStore.setState({ activePath: TASKS_PATH });

  assert.equal(win.location.pathname, '/tasks');
  assert.equal(win.location.search, '?mode=board'); // untouched by the early return
});
