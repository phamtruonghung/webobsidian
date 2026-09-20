/** Maps a persisted ui.theme value to its wrapper CSS class (see styles/obsidian.css). */
export const THEME_CLASS: Record<string, string> = {
  'obsidian-dark': 'theme-dark',
  'obsidian-light': 'theme-light',
  'catppuccin-mocha': 'theme-ctp-mocha',
  'catppuccin-macchiato': 'theme-ctp-macchiato',
  'catppuccin-frappe': 'theme-ctp-frappe',
  'catppuccin-latte': 'theme-ctp-latte',
};

export const themeClass = (t?: string): string => THEME_CLASS[t ?? ''] ?? 'theme-light';

/**
 * CSS selector for the element carrying the active theme class. Built from THEME_CLASS
 * (the single source of truth), so a new theme added there is picked up here automatically.
 * The canvas graph uses this to resolve its colours — see lib/cssColor.ts.
 */
export const THEME_SELECTOR = Object.values(THEME_CLASS)
  .map((c) => '.' + c)
  .join(', ');
