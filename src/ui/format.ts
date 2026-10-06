// Labels and badge colors shared by the table, drawer and tool cards.
import type { BadgeVariant } from "@cloudflare/kumo";

export type HostnameState =
  | "pending"
  | "verified"
  | "active"
  | "failed"
  | "conflict"
  | "deleting"
  | "deleted";

export const STATE_LABEL: Record<HostnameState, string> = {
  pending: "Pending",
  verified: "Verified",
  active: "Active",
  failed: "Failed",
  conflict: "Conflict",
  deleting: "Deleting",
  deleted: "Deleted"
};

export const STATE_BADGE: Record<HostnameState, BadgeVariant> = {
  pending: "warning",
  verified: "info",
  active: "success",
  failed: "error",
  conflict: "error",
  deleting: "secondary",
  deleted: "secondary"
};

export const SEVERITY_BADGE: Record<
  "error" | "warning" | "info",
  BadgeVariant
> = {
  error: "error",
  warning: "warning",
  info: "info"
};

export function isHostnameState(value: unknown): value is HostnameState {
  return typeof value === "string" && value in STATE_LABEL;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      });
}
