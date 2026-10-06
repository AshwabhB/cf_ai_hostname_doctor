// Read-only REST calls the browser makes for the hostname drawer. Same origin only.
import type { HostnameState } from "./format";

export type Finding = {
  code: string;
  severity: "error" | "warning" | "info";
  record: string;
  expected: string | null;
  observed: string[];
  observed_truncated: boolean;
  message: string;
};

export type HostnameDetail = {
  id: string;
  hostname: string;
  display_hostname: string;
  state: HostnameState;
  etag: string;
  certificate: {
    simulated: true;
    issuer: string;
    issued_at: string;
    not_after: string;
  } | null;
  created_at: string;
  updated_at: string;
};

export type Diagnosis = {
  checked_at: string | null;
  verifiable: boolean | null;
  findings: Finding[];
};

export type HostnameEvent = {
  id: number;
  from_state: HostnameState | null;
  to_state: HostnameState;
  actor: "user" | "model" | "system";
  reason: string | null;
  at: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!res.ok) {
    let title = "Request failed";
    try {
      title = ((await res.json()) as { title?: string }).title ?? title;
    } catch {
      // Not problem JSON. Keep the generic title.
    }
    throw new ApiError(res.status, title);
  }
  return res.json() as Promise<T>;
}

const base = (id: string) => `/api/v1/hostnames/${encodeURIComponent(id)}`;

export const api = {
  hostname: (id: string) => getJson<HostnameDetail>(base(id)),
  diagnosis: (id: string) => getJson<Diagnosis>(`${base(id)}/diagnosis`),
  events: (id: string) =>
    getJson<{ items: HostnameEvent[] }>(`${base(id)}/events?limit=50`)
};
