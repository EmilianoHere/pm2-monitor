// Type declarations for processes.js so any src/webui/*.test.ts spec importing
// it (and later views that import AGENT_REFRESH_MS) type-check under strict
// `tsc`. The runtime module is plain browser ES JavaScript; this sibling .d.ts
// is never emitted and never bundled. The ProcessesView class is DOM-bound; only
// the shared cadence constant and the public method shapes are declared.
export const AGENT_REFRESH_MS: number;

export interface ProcessesViewOptions {
  root: HTMLElement;
  onSelect?: (name: string | null) => void;
  confirm: (opts: Record<string, unknown>) => Promise<boolean>;
  toast: (msg: string, kind?: string) => void;
  onNavigate: (hash: string) => void;
  detailRoot?: HTMLElement;
  mode?: 'standalone' | 'server';
}

export class ProcessesView {
  constructor(opts: ProcessesViewOptions);
  setScope(opts?: { agentId?: string | null; filter?: 'problems' | null }): void;
  select(name: string | null): void;
  setProcesses(processes: Array<Record<string, unknown>>): void;
  destroy(): void;
  render(): void;
}
