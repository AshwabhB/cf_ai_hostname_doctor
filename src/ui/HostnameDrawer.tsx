// Details for one hostname: state, simulated certificate, findings, records to add, and
// the event timeline. Focus moves in when it opens and back to the row when it closes.
import { Badge, Button, Text } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  type Diagnosis,
  type HostnameDetail,
  type HostnameEvent
} from "./api";
import {
  SEVERITY_BADGE,
  STATE_BADGE,
  STATE_LABEL,
  formatTime,
  isHostnameState
} from "./format";
import type { HostnameRow } from "./HostnameTable";
import { Records } from "./Records";

type Loaded = {
  detail: HostnameDetail;
  diagnosis: Diagnosis;
  events: HostnameEvent[];
};

const ACTOR: Record<HostnameEvent["actor"], string> = {
  user: "You",
  model: "Assistant",
  system: "System"
};

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function HostnameDrawer({
  row,
  onClose
}: {
  row: HostnameRow | null;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The state badge on the row changes live; refetch the details when it does.
  const key = row
    ? `${row.id}:${row.state}:${row.last_checked_at ?? ""}`
    : null;

  useEffect(() => {
    if (!row) return;
    let active = true;
    setError(null);
    Promise.all([
      api.hostname(row.id),
      api.diagnosis(row.id),
      api.events(row.id)
    ])
      .then(([detail, diagnosis, events]) => {
        if (active) setData({ detail, diagnosis, events: events.items });
      })
      .catch(() => {
        if (active)
          setError("Could not load this hostname. Try again in a moment.");
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A native modal dialog gives the focus trap, Escape to close and the backdrop.
  // Closing returns focus to the row that opened it.
  useEffect(() => {
    const dialog = panel.current;
    if (!dialog) return;
    if (row && !dialog.open) dialog.showModal();
    if (!row && dialog.open) dialog.close();
  }, [row]);

  const detail = row && data?.detail.id === row.id ? data : null;

  return (
    <dialog
      ref={panel}
      aria-labelledby="drawer-title"
      onClose={onClose}
      className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-full sm:w-[28rem] overflow-y-auto bg-kumo-base text-kumo-default border-l border-kumo-line p-0 backdrop:bg-black/30"
    >
      {row && (
        <div className="p-5 space-y-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="drawer-title" className="text-lg font-semibold break-all">
                {row.display_hostname}
              </h2>
              {isHostnameState(row.state) && (
                <Badge variant={STATE_BADGE[row.state]}>
                  {STATE_LABEL[row.state]}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              shape="square"
              aria-label="Close details"
              icon={<XIcon size={16} />}
              onClick={onClose}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-kumo-danger">
              {error}
            </p>
          )}

          <Section title="Certificate">
            {detail?.detail.certificate ? (
              <div className="rounded-lg border border-kumo-line p-3 text-sm space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="beta">Simulated</Badge>
                  <span>Issued by {detail.detail.certificate.issuer}</span>
                </div>
                <Text size="xs" variant="secondary">
                  Valid until {formatTime(detail.detail.certificate.not_after)}.
                  This demo does not issue real certificates.
                </Text>
              </div>
            ) : (
              <Text size="sm" variant="secondary">
                Issued after verification. Certificates here are simulated.
              </Text>
            )}
          </Section>

          <Section title="Findings">
            {!detail ? (
              <Text size="sm" variant="secondary">
                Loading...
              </Text>
            ) : detail.diagnosis.checked_at === null ? (
              <Text size="sm" variant="secondary">
                Not checked yet.
              </Text>
            ) : (
              <>
                <Text size="xs" variant="secondary">
                  Checked {formatTime(detail.diagnosis.checked_at)}
                </Text>
                {detail.diagnosis.findings.length === 0 ? (
                  <Text size="sm">No problems found.</Text>
                ) : (
                  <ul className="space-y-2">
                    {detail.diagnosis.findings.map((f, i) => (
                      <li
                        key={`${f.code}-${i}`}
                        className="rounded-lg border border-kumo-line p-2 text-sm"
                      >
                        <Badge variant={SEVERITY_BADGE[f.severity]}>
                          {f.code}
                        </Badge>
                        <p className="mt-1">{f.message}</p>
                        {f.observed.length > 0 && (
                          <p className="mt-1 font-mono text-xs break-all text-kumo-subtle">
                            Found: {f.observed.map((o) => `"${o}"`).join(", ")}
                            {f.observed_truncated ? " (more not shown)" : ""}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Section>

          <Section title="Records to add">
            <Records records={row.records} />
          </Section>

          <Section title="Timeline">
            {!detail ? (
              <Text size="sm" variant="secondary">
                Loading...
              </Text>
            ) : (
              <ol className="space-y-2">
                {detail.events.map((e) => (
                  <li key={e.id} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATE_BADGE[e.to_state]}>
                        {STATE_LABEL[e.to_state]}
                      </Badge>
                      <Text size="xs" variant="secondary">
                        {ACTOR[e.actor]} · {formatTime(e.at)}
                      </Text>
                    </div>
                    {e.reason && (
                      <p className="mt-0.5 text-xs text-kumo-subtle">
                        {e.reason}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      )}
    </dialog>
  );
}
