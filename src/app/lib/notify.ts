// Tiny app-wide signals: a toast with an optional action, and "meals changed" so every
// list refreshes after a delete or restore made on another screen.
export type Toast = { text: string; action?: { label: string; run: () => void } };
let current: Toast | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const toastListeners = new Set<() => void>();

export const getToast = () => current;
export function showToast(t: Toast | null, ms = 8000) {
  clearTimeout(timer);
  current = t;
  toastListeners.forEach((fn) => fn());
  if (t) timer = setTimeout(() => showToast(null), ms);
}
export function onToast(fn: () => void) {
  toastListeners.add(fn);
  return () => void toastListeners.delete(fn);
}

const MEALS_CHANGED = "bitebook:meals-changed";
export const mealsChanged = () => window.dispatchEvent(new Event(MEALS_CHANGED));
export function onMealsChanged(fn: () => void) {
  window.addEventListener(MEALS_CHANGED, fn);
  return () => window.removeEventListener(MEALS_CHANGED, fn);
}
