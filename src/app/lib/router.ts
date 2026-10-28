import { useEffect, useState } from "preact/hooks";

// Hash routes, so the service worker's single cached shell serves every screen offline.
export type Route = { name: "meals"; missed?: boolean } | { name: "analyze" } | { name: "trends" } | { name: "memory" } | { name: "settings" } | { name: "meal"; id: string };

export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/meal\/([0-9A-HJKMNP-TV-Z]{26})$/);
  if (m) return { name: "meal", id: m[1] };
  if (hash === "#/missed") return { name: "meals", missed: true }; // Meals, with a no-photo meal open (D24)
  if (hash === "#/analyze") return { name: "analyze" };
  if (hash === "#/trends") return { name: "trends" };
  if (hash === "#/memory") return { name: "memory" };
  if (hash === "#/settings") return { name: "settings" };
  // Anything else, including #/timeline from before Today and Timeline were one tab (D37).
  return { name: "meals" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const mealHref = (id: string) => `#/meal/${id}`;
