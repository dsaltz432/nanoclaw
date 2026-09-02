import { useEffect, useState } from "react";
import { Badge, C, Card, Note, SourceLink, StatTile, Td, Th } from "./viz";

/**
 * Alerts — the rules, what they caught, and whether anything is running them.
 *
 * This tab is deliberately NOT a copy of Admin → Tasks. That page owns job
 * health: cron, last run, duration, exit status, trigger-now, and it gets fantasy
 * jobs for free the moment one is registered. Duplicating it here would create
 * two places to check that can disagree.
 *
 * What Admin structurally cannot show is the part that matters here: Admin knows
 * a task ran for 43 seconds and exited 0. It has no idea it said "Jeanty sprained
 * ankle", whether that was the fourth day of the same sprain, or whether it ever
 * reached you. That is fantasy-specific content with no home in a generic task
 * list, and it is what this tab is for.
 */

type Rule = { kind: string; severity: string; fires: string; caveat: string };

type LogRow = {
  alert_id: string;
  league: string;
  kind: string;
  severity: string;
  player_id: string | null;
  name: string | null;
  position: string | null;
  team: string | null;
  my_leagues: string[];
  what: string | null;
  headline: string | null;
  url: string | null;
  published_at: string | null;
  first_seen: string;
  last_seen: string;
  times_seen: number;
  delivered_at: string | null;
  delivery_target: string | null;
};

type Task = {
  id: string;
  name: string | null;
  group_folder: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
};

type AlertsData = {
  league: string;
  live: {
    alerts: {
      kind: string;
      severity: string;
      name: string;
      position: string | null;
      team: string | null;
      my_leagues: string[];
      what: string;
      at: string;
      notes: { headline: string; url: string | null }[];
    }[];
    hidden?: number;
    window_hours: number;
  };
  rules: Rule[];
  pending: LogRow[];
  history: LogRow[];
  counts: { logged: number; delivered: number };
  emit_command: string;
  delivery_note: string;
  schedule: { tasks: Task[]; configured: boolean; note: string };
  error?: string;
};

const SEV: Record<string, "critical" | "warning" | "info"> = {
  critical: "critical",
  warning: "warning",
  info: "info",
};

export default function AlertsTab({ league }: { league: string }) {
  const [data, setData] = useState<AlertsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDelivered, setShowDelivered] = useState(false);

  useEffect(() => {
    fetch(`/api/fantasy/alerts?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const history = showDelivered ? data.history : data.history.filter((r) => !r.delivered_at);

  // Until something has actually been sent, the Delivered column reads "never"
  // in warning amber on every row — a full column of identical alarm — and the
  // "include delivered" filter has nothing to include. Both describe a delivery
  // history that does not exist yet, so neither is drawn until it does.
  const anyDelivered = data.counts.delivered > 0 || data.history.some((r) => !!r.delivered_at);

  return (
    <div className="space-y-4">
      {/* ── is anything actually running? ───────────────────────────── */}
      {!data.schedule.configured ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">not scheduled</Badge>
            <span className="text-sm text-amber-100/90">
              These rules are evaluated when you open this page. Nothing reaches you unless you look.
            </span>
          </div>
          {/* The warning above is for every visit; the shell command below is
              for the one visit on which you decide to wire the job up. Leaving
              setup instructions permanently open at the top of the tab spent
              four lines and a code block of the most valuable space on the
              page restating a fact the badge already gives you. */}
          <details className="group mt-1.5">
            <summary className="ff-inline cursor-pointer list-none text-xs text-amber-300/80 hover:text-amber-200">
              <span className="group-open:hidden">How to make these proactive →</span>
              <span className="hidden group-open:inline">Hide setup</span>
            </summary>
            <p className="mt-2 text-xs leading-relaxed text-gray-400">
              A NanoClaw scheduled task runs{" "}
              <code className="rounded bg-gray-900 px-1 py-0.5 text-gray-300">{data.emit_command}</code> and sends
              whatever it prints. It prints nothing when there is nothing new — which is the behaviour a quiet job
              needs. Job health then appears in <strong className="text-gray-300">Admin → Tasks</strong> alongside
              every other subsystem; this page stays for what the alerts actually said.
            </p>
          </details>
        </div>
      ) : (
        <Card
          title="Scheduled jobs"
          subtitle="The fantasy subset only — full job health, run history and trigger-now live in Admin → Tasks"
        secondary
      >
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-800">
                <Th>Task</Th>
                <Th>Schedule</Th>
                <Th>Status</Th>
                <Th>Last run</Th>
                <Th>Next</Th>
              </tr>
            </thead>
            <tbody>
              {data.schedule.tasks.map((t) => (
                <tr key={t.id} className="border-b border-gray-800/60">
                  <Td>{t.name ?? t.id}</Td>
                  <Td className="text-xs text-gray-500">
                    {t.schedule_type} {t.schedule_value}
                  </Td>
                  <Td>
                    <Badge tone={t.status === "active" ? "good" : "neutral"}>{t.status}</Badge>
                  </Td>
                  <Td className="text-xs text-gray-500">{fmt(t.last_run)}</Td>
                  <Td className="text-xs text-gray-500">{fmt(t.next_run)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          <Note>{data.schedule.note}</Note>
        </Card>
      )}

      {/* With no job scheduled, "Delivered" is 0 and "Waiting to send" equals
          "Conditions logged" BY CONSTRUCTION — three tiles rendering one fact,
          and the two that are derivable are the two drawn in the alarming
          colour. They only become independent numbers once something is
          actually sending, so that is when they appear. */}
      <div
        className={`grid gap-3 ${
          data.schedule.configured ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2"
        }`}
      >
        <StatTile
          label="Live right now"
          value={data.live.alerts.length}
          hint={`conditions met in the last ${data.live.window_hours}h`}
        />
        <StatTile
          label="Conditions logged"
          value={data.counts.logged}
          hint={
            data.schedule.configured
              ? "all time, de-duplicated"
              : "all time, de-duplicated · none sent, nothing is scheduled"
          }
        />
        {data.schedule.configured && (
          <>
            <StatTile
              label="Delivered"
              value={data.counts.delivered}
              tone={data.counts.delivered === 0 ? "warning" : "default"}
              hint={data.counts.delivered === 0 ? "nothing has been sent yet" : "marked sent by a job"}
            />
            <StatTile
              label="Waiting to send"
              value={data.pending.length}
              hint="recorded, never delivered"
            />
          </>
        )}
      </div>

      {/* ── the log ─────────────────────────────────────────────────── */}
      <Card
        title="Alert log"
        subtitle="One row per CONDITION, not per run — a sprain that persists for four days is one alert seen four times. This is the part that cannot be reconstructed later."
        right={
          anyDelivered && (
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={showDelivered}
                onChange={(e) => setShowDelivered(e.target.checked)}
                className="accent-indigo-500"
              />
              include delivered
            </label>
          )
        }
      >
        {history.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing logged yet.</p>
        ) : (
          <div className="overflow-x-auto ff-stack-wrap">
            <table className="ff-stack w-full min-w-[820px] border-collapse">
              <thead>
                <tr className="border-b border-gray-800">
                  <Th>Severity</Th>
                  <Th>Kind</Th>
                  <Th>Player</Th>
                  <Th>What</Th>
                  <Th className="text-right">Seen</Th>
                  <Th>First</Th>
                  {anyDelivered && <Th>Delivered</Th>}
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.alert_id} className="border-b border-gray-800/60 align-top">
                    <Td data-label="Severity">
                      <Badge tone={SEV[r.severity] ?? "neutral"}>{r.severity}</Badge>
                    </Td>
                    <Td data-label="Kind" className="text-xs text-gray-500">{r.kind}</Td>
                    <Td data-label="" className="ff-row-head">
                      <span className="text-gray-100">
                        {r.position} {r.name}
                      </span>{" "}
                      <span className="text-xs text-gray-600">{r.team}</span>
                      {r.my_leagues?.length > 0 && (
                        <>
                          {" "}
                          <Badge tone="good">{r.my_leagues.join(", ")}</Badge>
                        </>
                      )}
                      {r.headline && (
                        <p className="mt-0.5 max-w-full text-xs leading-relaxed text-gray-500 sm:max-w-md">
                          {r.headline}
                          {r.url && <SourceLink href={r.url} />}
                        </p>
                      )}
                    </Td>
                    <Td data-label="What" className="text-xs text-gray-400">{r.what}</Td>
                    <Td data-label="Seen" className="text-right tabular-nums text-gray-500">{r.times_seen}</Td>
                    <Td data-label="First" className="whitespace-nowrap text-xs text-gray-600">{fmt(r.first_seen)}</Td>
                    {anyDelivered && (
                      <Td data-label="Delivered" className="whitespace-nowrap text-xs">
                        {r.delivered_at ? (
                          <span className="text-gray-500">
                            {fmt(r.delivered_at)}
                            {r.delivery_target ? ` → ${r.delivery_target}` : ""}
                          </span>
                        ) : (
                          <span style={{ color: C.warning }}>never</span>
                        )}
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Note>{data.delivery_note}</Note>
      </Card>

      {/* ── the rules, visible rather than buried in a regex ────────── */}
      <Card
        title="What fires an alert"
        subtitle="Four rules. Everything else is news, and news lives on the News tab."
        secondary
      >
        <ul className="space-y-3">
          {data.rules.map((r) => (
            <li key={r.kind} className="border-l-2 border-gray-800 pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">{r.kind}</Badge>
                <span className="text-xs text-gray-500">{r.severity}</span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-gray-300">{r.fires}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{r.caveat}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function fmt(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
