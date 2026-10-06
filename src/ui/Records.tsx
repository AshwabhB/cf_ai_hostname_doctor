// The DNS records a customer must add, as plain text with copy buttons.
import { Button, Text } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { LIMITS } from "../config/limits";

export type RequiredRecords = {
  apex: boolean;
  txt: { type: string; name: string; value: string };
  routing: { type: string; name: string; value: string; note: string };
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      shape="square"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      icon={copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), LIMITS.ui.copiedFeedbackMs);
        } catch {
          setCopied(false);
        }
      }}
    />
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="w-12 shrink-0 text-xs text-kumo-subtle">{label}</span>
      {/* DNS values are shown as plain text, never as markdown or HTML. */}
      <code className="flex-1 min-w-0 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <CopyButton value={value} label={label.toLowerCase()} />
    </div>
  );
}

function Record({
  type,
  name,
  value,
  note
}: {
  type: string;
  name: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-kumo-line p-2 space-y-1">
      <Text size="xs" bold>
        {type}
      </Text>
      <Field label="Name" value={name} />
      <Field label="Value" value={value} />
      {note && <p className="text-xs text-kumo-subtle">{note}</p>}
    </div>
  );
}

export function Records({ records }: { records: RequiredRecords }) {
  return (
    <div className="space-y-2">
      <Record {...records.txt} note="Proves you control the hostname." />
      <Record {...records.routing} />
    </div>
  );
}
