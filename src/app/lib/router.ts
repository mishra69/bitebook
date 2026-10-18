import { useEffect, useState } from "preact/hooks";

// Hash routes, so the service worker's single cached shell serves every screen offline.
export type Route = { name: "today" } | { name: "timeline" } | { name: "analyze" } | { name: "memory" } | { name: "meal"; id: string };

export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/meal\/([0-9A-HJKMNP-TV-Z]{26})$/);
  if (m) return { name: "meal", id: m[1] };
  if (hash === "#/timeline") return { name: "timeline" };
  if (hash === "#/analyze") return { name: "analyze" };
  if (hash === "#/memory") return { name: "memory" };
  return { name: "today" };
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
