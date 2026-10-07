// Tool results as small cards instead of raw JSON. Every value here came from our own
// server, but DNS strings inside it are attacker controlled, so all of it renders as
// plain text through React.
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import {
  CircleNotchIcon,
  TrashIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ReactNode } from "react";
import type { DeleteTarget } from "./ConfirmDelete";
import {
  SEVERITY_BADGE,
  STATE_BADGE,
  STATE_LABEL,
  isHostnameState,
  type HostnameState
} from "./format";
import { Records, type RequiredRecords } from "./Records";
import { AsciiName } from "./AsciiName";

type Output = Record<string, unknown>;

const RUNNING: Record<string, string> = {
  list_hostnames: "Listing hostnames",
  get_hostname: "Looking up",
  explain_findings: "Checking DNS for",
  add_hostname: "Adding",
  retry_hostname: "Retrying",
  propose_delete: "Preparing delete for"
};

function Card({
  children,
  tone = "line"
}: {
  children: ReactNode;
  tone?: "line" | "danger";
}) {
  return (
    <div className="flex justify-start">
      <Surface
        className={`w-full max-w-full sm:max-w-[85%] min-w-0 px-3 py-2 rounded-xl ring ${tone === "danger" ? "ring-kumo-danger" : "ring-kumo-line"}`}
      >
        {children}
      </Surface>
    </div>
  );
}

// Looks up a hostname's current state in the live table, by its stored ASCII name.
export type LiveState = (hostname: string) => string | undefined;

export type CardState = {
  state: HostnameState;
  // Set when the badge is the state from when the tool ran, not the live one.
  caption?: string;
};

// A card shows the hostname's live state while it is in the table. Once it is gone (for
// example deleted), it falls back to the state the tool returned, labeled as such, so
// an old state never reads as current.
export function cardState(
  tool: string,
  toolState: unknown,
  liveState: unknown
): CardState | null {
  if (isHostnameState(liveState)) return { state: liveState };
  if (!isHostnameState(toolState)) return null;
  return {
    state: toolState,
    caption: tool === "add_hostname" ? "when added" : "at the time"
  };
}

function StateBadge({
  tool,
  output,
  live
}: {
  tool: string;
  output: Output;
  live?: LiveState;
}) {
  const shown = cardState(
    tool,
    output.state,
    live?.(String(output.hostname ?? ""))
  );
  if (!shown) return null;
  return (
    <>
      <Badge variant={STATE_BADGE[shown.state]}>
        {STATE_LABEL[shown.state]}
      </Badge>
      {shown.caption && (
        <span className="text-xs text-kumo-subtle">{shown.caption}</span>
      )}
    </>
  );
}

function Title({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">{children}</div>
  );
}

function host(o: Output): string {
  return String(o.display_hostname ?? o.hostname ?? "");
}

function Findings({ findings }: { findings: Output[] }) {
  if (findings.length === 0) {
    return <p className="text-xs text-kumo-subtle">No problems found.</p>;
  }
  return (
    <ul className="mt-1 space-y-1">
      {findings.map((f, i) => {
        const severity =
          f.severity === "error" || f.severity === "warning"
            ? f.severity
            : "info";
        const observed = Array.isArray(f.observed)
          ? (f.observed as string[])
          : [];
        return (
          <li key={`${String(f.code)}-${i}`} className="text-xs">
            <div className="flex items-center gap-2">
              <Badge variant={SEVERITY_BADGE[severity]}>{String(f.code)}</Badge>
            </div>
            <p className="mt-0.5 text-kumo-default">
              {String(f.message ?? "")}
            </p>
            {observed.length > 0 && (
              <p className="mt-0.5 font-mono break-all text-kumo-subtle">
                Found: {observed.map((o) => `"${o}"`).join(", ")}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function body(
  name: string,
  o: Output,
  onDelete: (t: DeleteTarget) => void,
  live?: LiveState
): ReactNode {
  if (o.found === false || o.added === false || o.retried === false) {
    return (
      <Title>
        <WarningCircleIcon size={14} className="text-kumo-warning" />
        <Text size="sm">{String(o.error ?? "That did not work.")}</Text>
      </Title>
    );
  }
  switch (name) {
    case "list_hostnames": {
      const list = Array.isArray(o.hostnames) ? (o.hostnames as Output[]) : [];
      return (
        <Text size="sm">
          {list.length === 0
            ? "No hostnames yet."
            : `${list.length} hostname${list.length === 1 ? "" : "s"}`}
        </Text>
      );
    }
    case "get_hostname":
    case "add_hostname":
      return (
        <div className="space-y-2">
          <Title>
            <Text size="sm" bold>
              {name === "add_hostname" ? `Added ${host(o)}` : host(o)}
            </Text>
            <StateBadge tool={name} output={o} live={live} />
          </Title>
          <AsciiName ascii={String(o.hostname ?? "")} display={host(o)} />
          {o.records ? (
            <Records records={o.records as RequiredRecords} />
          ) : null}
        </div>
      );
    case "explain_findings":
      return (
        <div>
          <Title>
            <Text size="sm" bold>
              DNS check for {host(o)}
            </Text>
            <StateBadge tool={name} output={o} live={live} />
          </Title>
          <Findings
            findings={Array.isArray(o.findings) ? (o.findings as Output[]) : []}
          />
        </div>
      );
    case "retry_hostname":
      return (
        <Title>
          <Text size="sm">Checking {host(o)} again</Text>
          <StateBadge tool={name} output={o} live={live} />
        </Title>
      );
    case "propose_delete": {
      const target: DeleteTarget = {
        id: String(o.id ?? ""),
        etag: String(o.etag ?? ""),
        hostname: String(o.hostname ?? ""),
        display_hostname: host(o)
      };
      return (
        <div className="space-y-2">
          <Text size="sm">
            Nothing has been deleted. Review and confirm if you want to remove
            it.
          </Text>
          <Button
            variant="destructive"
            size="sm"
            icon={<TrashIcon size={14} />}
            onClick={() => onDelete(target)}
          >
            Delete {target.display_hostname}...
          </Button>
          <AsciiName
            ascii={target.hostname}
            display={target.display_hostname}
          />
        </div>
      );
    }
    default:
      return <Text size="sm">Done.</Text>;
  }
}

export function ToolCard({
  part,
  onDelete,
  live
}: {
  part: UIMessage["parts"][number];
  onDelete: (t: DeleteTarget) => void;
  live?: LiveState;
}) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const input = (part.input ?? {}) as Output;

  if (part.state === "input-streaming" || part.state === "input-available") {
    return (
      <Card>
        <Title>
          <CircleNotchIcon
            size={14}
            className="animate-spin text-kumo-subtle"
          />
          <Text size="sm" variant="secondary">
            {RUNNING[name] ?? "Working"}{" "}
            {typeof input.hostname === "string" ? input.hostname : ""}
          </Text>
        </Title>
      </Card>
    );
  }
  if (part.state === "output-error") {
    return (
      <Card tone="danger">
        <Title>
          <WarningCircleIcon size={14} className="text-kumo-danger" />
          <Text size="sm">That action could not run. Nothing was changed.</Text>
        </Title>
      </Card>
    );
  }
  if (part.state !== "output-available") return null;
  return (
    <Card>{body(name, (part.output ?? {}) as Output, onDelete, live)}</Card>
  );
}
