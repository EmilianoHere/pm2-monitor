// Type declarations for detailPanel.js so any src/webui/*.test.ts spec importing
// it type-checks under strict `tsc`. The runtime module is plain browser ES
// JavaScript; this sibling .d.ts is never emitted and never bundled. The
// DetailPanel class is DOM-bound; only the public contract FEAT-005 wires is
// declared.
export interface DetailPanelOptions {
  root: HTMLElement;
  ws: unknown;
  toast: (msg: string, kind?: string) => void;
  confirm: (opts: Record<string, unknown>) => Promise<boolean>;
  agentId?: string;
}

export class DetailPanel {
  constructor(opts: DetailPanelOptions);
  mount(name: string, agentId?: string, tableSet?: Array<Record<string, unknown>>): Promise<void>;
  unmount(): void;
  updateFrom(tableSet: Array<Record<string, unknown>>): void;
  render(): void;
}
