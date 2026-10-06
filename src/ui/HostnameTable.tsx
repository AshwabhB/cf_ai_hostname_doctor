// Live hostname list. Rows come from the summary the server pushes with setState after
// every change, so badges update without polling.
import { Badge, Empty, Text } from "@cloudflare/kumo";
import { GlobeIcon } from "@phosphor-icons/react";
import {
  STATE_BADGE,
  STATE_LABEL,
  formatTime,
  isHostnameState
} from "./format";
import type { RequiredRecords } from "./Records";
import { AsciiName } from "./AsciiName";

export type HostnameRow = {
  id: string;
  hostname: string;
  display_hostname: string;
  state: string;
  records: RequiredRecords;
  last_checked_at: string | null;
  finding_codes: string[];
};

export function HostnameTable({
  rows,
  onOpen
}: {
  rows: HostnameRow[];
  onOpen: (row: HostnameRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="p-6">
        <Empty
          icon={<GlobeIcon size={28} />}
          title="No hostnames yet"
          description="Ask the assistant to add one."
        />
      </div>
    );
  }
  return (
    <table className="w-full table-fixed text-sm">
      <caption className="sr-only">Your custom hostnames</caption>
      <thead>
        <tr className="text-left text-xs text-kumo-subtle border-b border-kumo-line">
          <th scope="col" className="px-4 py-2 font-medium">
            Hostname
          </th>
          <th scope="col" className="w-24 px-2 py-2 font-medium">
            State
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id ?? row.hostname}
            className="border-b border-kumo-line hover:bg-kumo-tint"
          >
            <td className="px-4 py-2 min-w-0">
              {/* A real button, so the drawer opens from the keyboard too. */}
              <button
                type="button"
                onClick={() => onOpen(row)}
                className="block w-full min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring rounded"
              >
                <span
                  className="block truncate font-medium text-kumo-default"
                  title={row.display_hostname}
                >
                  {row.display_hostname}
                </span>
                <AsciiName
                  ascii={row.hostname}
                  display={row.display_hostname}
                />
                <Text size="xs" variant="secondary">
                  Checked {formatTime(row.last_checked_at)}
                  {row.finding_codes.length > 0
                    ? ` · ${row.finding_codes.join(", ")}`
                    : ""}
                </Text>
              </button>
            </td>
            <td className="px-2 py-2 align-middle">
              {isHostnameState(row.state) ? (
                <Badge variant={STATE_BADGE[row.state]}>
                  {STATE_LABEL[row.state]}
                </Badge>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
