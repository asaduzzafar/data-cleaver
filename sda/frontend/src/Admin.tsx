import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText, formatBytes } from "./api";
import { useDesktop } from "./desktop";
import { JobStatus, useJob } from "./jobs";
import { Button, Card, InfoTip, Input, Notice, Switch } from "./ui";
import type { BackupResult, Health, Job } from "./types";

type DemoStatus = {
  state: "installed" | "installing" | "not_installed" | "failed";
  enabled: boolean;
  error: string | null;
  removes: { sources: string[]; slices: string[] };
};

type Storage = { database_dir: string; parquet_dir: string; changeable: boolean };

/** Settings: demo data, backup, where data is kept, and this computer. */
export function Admin({ health, onChanged }: { health: Health; onChanged: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="px-1 pt-2 font-(family-name:--font-display) text-[30px] leading-tight
                     font-bold tracking-[-0.035em]">
        Settings
      </h2>
      <DemoData onChanged={onChanged} />
      <Backup />
      <StorageSettings onChanged={onChanged} />
      <ThisComputer health={health} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <Card>
      <section aria-labelledby={id} className="flex flex-col gap-3">
        <h3 id={id} className="font-(family-name:--font-display) text-[18px] font-bold tracking-[-0.01em]">{title}</h3>
        {children}
      </section>
    </Card>
  );
}

function DemoData({ onChanged }: { onChanged: () => void }) {
  const client = useQueryClient();
  const hint = useId();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["sample"],
    queryFn: () => api.get<DemoStatus>("/sample"),
    refetchInterval: (q) => (q.state.data?.state === "installing" ? 1_500 : false),
  });
  const set = async (on: boolean) => {
    setError(null);
    try {
      const next = on ? await api.post<DemoStatus>("/sample", {})
                      : await api.del<DemoStatus>("/sample");
      client.setQueryData(["sample"], next);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const removes = data ? [...data.removes.sources, ...data.removes.slices] : [];

  return (
    <Section title="Demo data">
      <Switch label="Enable demo data" checked={!!data?.enabled} describedBy={hint}
              disabled={!data || data.state === "installing"}
              onChange={(on) => (on ? void set(true) : setConfirming(true))} />
      <p id={hint} className="text-ink-2">
        {data?.state === "installing"
          ? "Preparing the sample: a million generated orders and their customers…"
          : "A generated sample of orders and customers to explore. Nothing in it is real."}
      </p>
      {confirming && (
        <Notice tone="caution" title="Turn the demo data off?">
          This removes{" "}
          {removes.length ? removes.map((n, i) => (
            <span key={n}>{i ? ", " : ""}<code>{n}</code></span>)) : "the sample"}
          {data?.removes.slices.length ? ", including the slices cut from it" : ""}. Your
          own sources are not touched.
          <div className="mt-2.5 flex gap-2">
            <Button variant="danger" onClick={() => void set(false)}>Remove the demo data</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Keep it</Button>
          </div>
        </Notice>
      )}
      {(error || data?.state === "failed") && (
        <p role="alert" className="text-stop">{error ?? data?.error}</p>
      )}
    </Section>
  );
}

function Backup() {
  const client = useQueryClient();
  const backup = useJob();
  const { data } = useQuery({
    queryKey: ["backups"],
    queryFn: () => api.get<{
      root: string;
      backups: { name: string; files: number; bytes: number; created: string }[];
    }>("/admin/backups"),
  });
  const result = backup.job?.state === "done"
    ? (backup.job.result as BackupResult) : null;

  return (
    <Section title="Backup">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={backup.busy}
                onClick={() => backup.start(async () => {
                  const job = await api.post<Job>("/admin/backup");
                  setTimeout(() => client.invalidateQueries({ queryKey: ["backups"] }), 1500);
                  return job;
                })}>
          {backup.busy ? "Backing up…" : "Back up now"}
        </Button>
        <InfoTip label="What this does and does not cover">
          It saves the registry and every saved slice: who cut what, from where,
          when, and with what SQL. The Parquet copies of your sources are not
          included; they can be rebuilt by loading the CSVs again. The lineage
          cannot, which is why it is backed up.
        </InfoTip>
      </div>
      <JobStatus job={backup.job} onCancel={backup.cancel} />
      {result && (
        <Notice tone="info" title={`Backed up to ${result.name}`}>
          {result.files} files · {formatBytes(result.bytes)}
          <div className="mt-1 font-mono text-[12px] break-all">{result.path}</div>
        </Notice>
      )}
      {data && data.backups.length > 0 && (
        <ul aria-label="Earlier backups" className="flex flex-col divide-y divide-line">
          {data.backups.slice(0, 5).map((b) => (
            <li key={b.name} className="flex items-center gap-3 py-2 text-[13px]">
              <span className="font-mono">{b.name}</span>
              <span className="text-muted">{b.files} files · {formatBytes(b.bytes)}</span>
              <span className="ml-auto text-muted">{b.created.replace("T", " ")}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function StorageSettings({ onChanged }: { onChanged: () => void }) {
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: ["storage"],
    queryFn: () => api.get<Storage>("/admin/storage"),
  });
  const change = async (body: Partial<Storage>) => {
    const next = await api.post<Storage>("/admin/storage", body);
    client.setQueryData(["storage"], next);
    // A new database is a different catalog: refetch everything.
    void client.invalidateQueries();
    onChanged();
  };
  if (!data) return null;
  return (
    <Section title="Where your data is kept">
      <FolderSetting label="Database folder" value={data.database_dir}
                     disabled={!data.changeable}
                     note="Choosing a folder starts fresh there, or opens the Data Cleaver database already in it. This one stays where it is."
                     onPick={(path) => change({ database_dir: path })} />
      <FolderSetting label="Parquet folder" value={data.parquet_dir}
                     disabled={!data.changeable}
                     note="New loads save their Parquet copies here. Sources already loaded keep their files."
                     onPick={(path) => change({ parquet_dir: path })} />
      {!data.changeable && (
        <p className="text-muted">These locations are set by how Data Cleaver was started.</p>
      )}
    </Section>
  );
}

/** A folder with a Change… key: the Windows folder picker in the desktop app,
 *  a typed path in a browser. */
function FolderSetting({ label, value, note, onPick, disabled }: {
  label: string; value: string; note: string; disabled?: boolean;
  onPick: (path: string) => Promise<void>;
}) {
  const desktop = useDesktop();
  const id = useId();
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (path: string) => {
    setError(null);
    setBusy(true);
    try {
      await onPick(path);
      setTyping(false);
      setDraft("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    if (desktop) {
      const picked = await desktop.pick_folder();
      if (picked) await apply(picked);
    } else {
      setTyping(true);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p id={id} className="text-[13px] font-medium text-ink-2">{label}</p>
          <p className="font-mono text-[12.5px] break-all text-ink" aria-labelledby={id}>{value}</p>
        </div>
        <Button onClick={() => void choose()} disabled={disabled || busy}
                aria-label={`Change the ${label.toLowerCase()}`}>
          {busy ? "Switching…" : "Change…"}
        </Button>
      </div>
      {typing && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void apply(draft); }}>
          <Input aria-label={`New ${label.toLowerCase()} (full path)`} value={draft}
                 placeholder="C:/Users/you/Documents/Data Cleaver"
                 onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" variant="primary" disabled={!draft.trim() || busy}>Use this folder</Button>
          <Button variant="ghost" onClick={() => setTyping(false)}>Cancel</Button>
        </form>
      )}
      <p className="text-[13px] text-muted">{note}</p>
      {error && <p role="alert" className="text-[13px] text-stop">{error}</p>}
    </div>
  );
}

function ThisComputer({ health }: { health: Health }) {
  const q = health.queries;
  return (
    <Section title="This computer">
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="text-[13px] font-medium text-ink-2">Memory for queries</dt>
          <dd className="text-[15px] font-semibold">{memory(health.memory_limit)} · {health.threads} threads</dd>
        </div>
        <div>
          <dt className="text-[13px] font-medium text-ink-2">Queries at once</dt>
          <dd className="text-[15px] font-semibold">
            {q.running} running · {q.waiting} waiting · {q.free} free
          </dd>
        </div>
      </dl>
      <p className="text-[13px] text-muted">
        Sized from this computer: half its memory, so the rest of your machine
        keeps running while a large query works.
      </p>
    </Section>
  );
}

/** "7884MB" -> "7.7 GB": the engine's setting, as a person reads memory. */
function memory(limit: string) {
  const m = /^(\d+(?:\.\d+)?)\s*(MB|GB|MiB|GiB)$/i.exec(limit.trim());
  if (!m) return limit;
  const gb = /^g/i.test(m[2]) ? Number(m[1]) : Number(m[1]) / 1024;
  return `${gb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
}
