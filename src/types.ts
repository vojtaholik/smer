export const EVENT_KINDS = [
  "shell_cmd",
  "git_commit",
  "agent_session",
  "browser_visit",
  "deploy",
  "api_job",
  "note",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number] | `x-${string}`;

export interface EventEnvelope {
  ts: number;
  source: string;
  kind: EventKind;
  project: string | null;
  title: string;
  text: string;
  meta: Record<string, unknown>;
}

export interface StoredEvent extends EventEnvelope {
  id: number;
}

export interface ProjectRecord {
  id?: number;
  name: string;
  path: string;
  repo?: string | null;
  domains: string[];
  keywords: string[];
  discoveredAt?: number;
}

export interface ProviderStatus {
  id: string;
  adapter: string;
  enabled: boolean;
  healthy: boolean;
  lastRun: number | null;
  cursor: string | null;
  error: string | null;
  details?: string;
}

export interface SmerConfig {
  devRoots: string[];
  browserDenylist: string[];
  excludedRoots: string[];
  emailAllowlist: string[];
  enabledProviders: string[];
  providerIntervals: Record<string, number>;
  cloud: Record<string, Record<string, string | number | boolean>>;
}

export interface CommandEnvelope<T = unknown> {
  ok: boolean;
  command: string;
  result: T;
  next_actions: string[];
}

export interface RuntimeContext {
  home: string;
  json: boolean;
  quiet: boolean;
}
