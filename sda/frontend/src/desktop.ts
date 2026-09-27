import { useEffect, useState } from "react";

/** The desktop shell's bridge (pywebview), when running inside it. */
type DesktopApi = { pick_folder: () => Promise<string | null> };

declare global {
  interface Window { pywebview?: { api: DesktopApi } }
}

/** The bridge, or null in a plain browser. pywebview injects it after the
 *  page loads and announces it with a `pywebviewready` event. */
export function useDesktop(): DesktopApi | null {
  const [api, setApi] = useState<DesktopApi | null>(
    () => window.pywebview?.api ?? null);
  useEffect(() => {
    if (api) return;
    const ready = () => setApi(window.pywebview?.api ?? null);
    window.addEventListener("pywebviewready", ready);
    return () => window.removeEventListener("pywebviewready", ready);
  }, [api]);
  return api;
}
