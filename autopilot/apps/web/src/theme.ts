/** Theme: "system" follows prefers-color-scheme; "light"/"dark" force it via data-theme on <html>. Persisted locally. */
export type Theme = "system" | "light" | "dark";
const KEY = "autopilot.theme";
export function getTheme(): Theme {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  return v === "light" || v === "dark" ? v : "system";
}
export function applyTheme(t: Theme) {
  if (t === "system") {
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem(KEY, t);
    document.documentElement.dataset.theme = t;
  }
}
export const nextTheme = (t: Theme): Theme => (t === "system" ? "dark" : t === "dark" ? "light" : "system");
