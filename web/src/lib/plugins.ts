/**
 * Obsidian community-plugin loader + API shim (PRD FR-8, browser side).
 *
 * Obsidian plugins are CommonJS modules that `require('obsidian')` and export a
 * default class extending `Plugin`. We provide a compatibility shim exposing a
 * commonly-used subset of the Obsidian API, then evaluate each enabled plugin's
 * main.js against it. Plugins relying on Electron/Node internals will fail
 * softly (their missing-API calls throw and are caught) — logged, not fatal.
 */
import { api } from './api';
import { useStore } from './store';
import { themedPopupHost } from './theme';

// ---- Minimal Obsidian API shim ------------------------------------------
class Events {
  private handlers: Record<string, Function[]> = {};
  on(name: string, cb: Function) { (this.handlers[name] ??= []).push(cb); return { name, cb }; }
  off(name: string, cb: Function) { this.handlers[name] = (this.handlers[name] ?? []).filter((h) => h !== cb); }
  trigger(name: string, ...args: unknown[]) { (this.handlers[name] ?? []).forEach((h) => h(...args)); }
}

class Notice {
  constructor(message: string, _timeout?: number) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    // Inside the themed root, not `<body>`: `.toast` reads palette variables, so on
    // `<body>` it would render unthemed (transparent, black text on the dark themes).
    themedPopupHost().appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
}

class TFile {
  constructor(public path: string, public name: string) {}
  get basename() { return this.name.replace(/\.[^.]+$/, ''); }
  get extension() { return this.name.split('.').pop() ?? ''; }
}

class Vault extends Events {
  getName() { return 'WebObsidian'; }
  async read(file: TFile) { const r = await api.read(file.path); return typeof r === 'string' ? r : r.content; }
  async cachedRead(file: TFile) { return this.read(file); }
  async modify(file: TFile, data: string) { await api.write(file.path, data); }
  async create(path: string, data: string) { await api.write(path, data); return new TFile(path, path.split('/').pop()!); }
  async delete(file: TFile) { await api.remove(file.path); }
  getMarkdownFiles(): TFile[] { return flattenFiles(); }
  getFiles(): TFile[] { return flattenFiles(); }
  getAbstractFileByPath(path: string) { return new TFile(path, path.split('/').pop() ?? path); }
}

class Workspace extends Events {
  getActiveFile(): TFile | null {
    const p = useStore.getState().activePath;
    return p ? new TFile(p, p.split('/').pop()!) : null;
  }
  onLayoutReady(cb: () => void) { cb(); }
}

class App {
  vault = new Vault();
  workspace = new Workspace();
  metadataCache = new Events();
  keymap = {};
  setting = {};
}

abstract class Component {
  registerEvent(_e: unknown) {}
  registerInterval(id: number) { return id; }
  load() {}
  unload() {}
  addChild<T>(c: T) { return c; }
}

abstract class Plugin extends Component {
  app: App;
  manifest: unknown;
  constructor(app: App, manifest: unknown) { super(); this.app = app; this.manifest = manifest; }
  addCommand(_cmd: unknown) {}
  addRibbonIcon(_icon: string, _title: string, _cb: Function) { return document.createElement('div'); }
  addStatusBarItem() { return document.createElement('div'); }
  addSettingTab(_tab: unknown) {}
  async loadData() { return {}; }
  async saveData(_data: unknown) {}
  registerMarkdownPostProcessor(_fn: unknown) {}
  registerView(_t: string, _f: unknown) {}
  abstract onload(): void | Promise<void>;
  onunload() {}
}

class PluginSettingTab { constructor(public app: App, public plugin: Plugin) {} display() {} hide() {} }
class Modal { constructor(public app: App) {} open() {} close() {} onOpen() {} onClose() {} }
class Setting {
  constructor(containerEl: HTMLElement) { this.el = containerEl; }
  el: HTMLElement;
  setName(_n: string) { return this; }
  setDesc(_d: string) { return this; }
  addText(cb: Function) { cb({ setValue: () => ({}), onChange: () => ({}), setPlaceholder: () => ({}) }); return this; }
  addToggle(cb: Function) { cb({ setValue: () => ({}), onChange: () => ({}) }); return this; }
  addButton(cb: Function) { cb({ setButtonText: () => ({}), onClick: () => ({}), setCta: () => ({}) }); return this; }
  addDropdown(cb: Function) { cb({ addOption: () => ({}), setValue: () => ({}), onChange: () => ({}) }); return this; }
}

function flattenFiles(): TFile[] {
  const tree = useStore.getState().tree;
  const out: TFile[] = [];
  const walk = (n: any) => {
    if (n.type === 'file') out.push(new TFile(n.path, n.name));
    n.children?.forEach(walk);
  };
  tree?.children?.forEach(walk);
  return out;
}

const obsidianModule = {
  App, Plugin, Component, Notice, TFile, Vault, Workspace, Events,
  PluginSettingTab, Modal, Setting,
  MarkdownView: class {}, ItemView: class {}, addIcon: () => {},
  normalizePath: (p: string) => p.replace(/\\/g, '/'),
  moment: () => ({ format: () => new Date().toISOString() }),
};

const sharedApp = new App();
const loaded = new Map<string, { instance: Plugin }>();

/** Evaluate one plugin's main.js against the shim. */
async function loadPlugin(id: string, manifest: any) {
  if (loaded.has(id)) return;
  const code = await fetch(`/api/plugins/${id}/main.js`, { credentials: 'include' }).then((r) => r.text());
  const module = { exports: {} as any };
  const require = (name: string) => {
    if (name === 'obsidian') return obsidianModule;
    throw new Error(`Plugin "${id}" required unsupported module: ${name}`);
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', code);
  fn(module, module.exports, require);
  const PluginClass = module.exports.default ?? module.exports;
  const instance: Plugin = new PluginClass(sharedApp, manifest);
  await instance.onload?.();
  loaded.set(id, { instance });
  // inject plugin styles if any
  if (manifest.hasStyles) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/api/plugins/${id}/styles.css`;
    document.head.appendChild(link);
  }
  console.log(`[plugin] loaded ${id}`);
}

/** Load all enabled community plugins. Failures are logged, not fatal. */
export async function loadPlugins(): Promise<void> {
  try {
    const { plugins } = await api.listPlugins();
    for (const p of plugins.filter((x: any) => x.enabled)) {
      try {
        await loadPlugin(p.id, p);
      } catch (e) {
        console.warn(`[plugin] failed to load ${p.id}:`, e);
        new Notice(`Plugin "${p.name}" failed to load (incompatible API)`);
      }
    }
  } catch {
    /* not authed / no plugins */
  }
}
