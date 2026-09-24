import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Admin } from "./Admin";
import { Logo } from "./Logo";
import { LoadPanel, Sources } from "./Sources";
import { Workspace } from "./Workspace";
import { api, errorText } from "./api";
import { Button, Card, Icon, Notice } from "./ui";
import type { Health, Relation } from "./types";

export default function App() {
  const client = useQueryClient();
  const [view, setView] = useState<"data" | "server">("data");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<Health>("/health"),
    // Slot occupancy is shared state: it changes because of what other people
    // are doing, so it has to be pulled rather than waited for.
    refetchInterval: 5_000,
    // The global default switches focus-refetching off, which is right for
    // queries that cost a slot and wrong for this one. React Query also
    // pauses intervals in a background tab, so without this an analyst coming
    // back to the tab reads a slot count from whenever they left.
    refetchOnWindowFocus: true,
  });

  const relations = useQuery({
    queryKey: ["relations"],
    queryFn: async () =>
      (await api.get<{ relations: Relation[] }>("/relations")).relations,
  });

  // Health is polled; the catalog is not. When a load finishes in the
  // background -- the first-run sample install, or a load whose panel was
  // closed -- the catalog version in health moves, and the list refetches.
  const catalogVersion = health.data?.catalog_version;
  useEffect(() => {
    if (catalogVersion !== undefined) {
      void client.invalidateQueries({ queryKey: ["relations"] });
    }
  }, [catalogVersion, client]);

  const all = relations.data ?? [];
  const current = all.find((r) => r.name === selected) ?? null;

  useEffect(() => {
    if (!selected && all.length > 0) setSelected(all[0].name);
    if (selected && all.length > 0 && !all.some((r) => r.name === selected)) {
      setSelected(all[0].name);
    }
  }, [all, selected]);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["relations"] });
    void client.invalidateQueries({ queryKey: ["health"] });
  };

  // Choosing a source always shows it, whatever the main area was showing.
  const open = (name: string) => {
    setSelected(name);
    setView("data");
    setLoading(false);
  };

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0"); } catch { /* see readCollapsed */ }
  };

  return (
    <div className="flex h-full gap-3 p-3">
      <aside aria-label="Sidebar"
             className={`flex shrink-0 flex-col rounded-2xl border border-side-line bg-side
               text-side-ink transition-[width] duration-200 ease-(--ease-detent) ${
               collapsed ? "w-[60px]" : "w-[232px]"}`}>
        <div className={`flex items-center gap-2 pt-4 pb-3 ${collapsed ? "flex-col px-2" : "px-4"}`}>
          <h1 aria-label="Data Cleaver" className="min-w-0 flex-1">
            <Logo wordmark={!collapsed} />
          </h1>
          <button type="button" onClick={toggle} aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
                  title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
                  className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center
                             rounded-lg text-side-muted hover:bg-side-hover hover:text-side-ink">
            <Icon name="sidebar" size={16} />
          </button>
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto pb-3 ${collapsed ? "px-2" : "px-3"}`}>
          <Sources relations={all} selected={view === "data" && !loading ? selected : null}
                   onSelect={open} onChanged={refresh} collapsed={collapsed}
                   loading={loading} onLoading={(on) => { setLoading(on); if (on) setView("data"); }} />
        </div>

        <div className={`border-t border-side-line py-2 ${collapsed ? "px-2" : "px-3"}`}>
          <button type="button" onClick={() => { setView("server"); setLoading(false); }}
                  aria-current={view === "server" ? "page" : undefined}
                  aria-label={collapsed ? "Settings" : undefined}
                  title={collapsed ? "Settings" : undefined}
                  className={`flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg
                    text-[14px] transition-colors duration-150 ${collapsed ? "justify-center" : "px-2.5"} ${
                    view === "server" ? "bg-side-active font-semibold text-side-ink"
                      : "text-side-muted hover:bg-side-hover hover:text-side-ink"}`}>
            <Icon name="gear" size={17} />
            {!collapsed && "Settings"}
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto rounded-2xl">
        <div className="mx-auto flex max-w-[1560px] flex-col gap-4 pb-6">
        {health.error && (
          <Notice tone="warn" title="Data Cleaver's engine is not responding">
            {errorText(health.error)}
            <div className="mt-1">
              In development, start it from <code>sda/backend</code> with{" "}
              <code>uvicorn app.main:app --workers 1 --port 8000</code>.
            </div>
          </Notice>
        )}

        {health.data && view === "data" && health.data.folders.length === 0 && (
          <Notice tone="caution" title="No folders added yet">
            Data Cleaver only reads files from folders you add. Choose{" "}
            <em>Load a CSV</em> and add the folder your files are in.
          </Notice>
        )}
        {health.data && view === "data"
          && health.data.folders.some((f) => !f.present) && (
          <Notice tone="warn" title="A folder has gone missing">
            {health.data.folders.filter((f) => !f.present).map((f) => (
              <code key={f.path} className="block">{f.path}</code>
            ))}
            It was moved or deleted after it was added. Sources already loaded
            from it still work.
          </Notice>
        )}

        {view === "server" && health.data && <Admin health={health.data} onChanged={refresh} />}

        {view === "data" && loading && (
          <LoadPanel relations={all} onClose={() => setLoading(false)}
                     onDone={(name) => { setLoading(false); refresh();
                                         if (name) open(name); }} />
        )}

        {view === "data" && !loading && current && (
          <Workspace relation={current} relations={all}
                     onChanged={refresh} onOpen={open} />
        )}

        {view === "data" && !loading && relations.isSuccess && all.length === 0 && (
          <Card className="flex flex-col items-start gap-3">
            <h2 className="font-(family-name:--font-display) text-[20px] font-bold">Nothing loaded yet</h2>
            <p className="text-ink-2">
              Load a CSV from one of your folders, or turn on the demo data in Settings.
            </p>
            <Button variant="primary" onClick={() => setLoading(true)}>
              <Icon name="plus" size={14} />Load a CSV
            </Button>
          </Card>
        )}
        </div>
      </main>
    </div>
  );
}

const SIDEBAR_KEY = "data-cleaver.sidebar-collapsed";

/** Storage can be missing or refuse writes; the sidebar then starts open. */
function readCollapsed() {
  try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; }
}
