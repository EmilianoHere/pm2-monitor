// Type declarations for compute.js so the src/webui/*.test.ts specs type-check
// under strict `tsc`. The runtime module is plain browser ES JavaScript; this
// sibling .d.ts is never emitted and never bundled.
export const DEFAULT_UNSTABLE_THRESHOLD: number;
export function unstableThreshold(): number;

export type ProcessClass = 'crashed' | 'unstable' | 'healthy' | 'stopped';

export function classifyProcess(p: Record<string, unknown>, threshold?: number): ProcessClass;
export function needsAttention(p: Record<string, unknown>, t?: number): boolean;
export function attentionCounts(
  procs: Array<Record<string, unknown>>,
  t?: number,
): { crashed: number; unstable: number; total: number };
export function attentionSummary(counts: { crashed: number; unstable: number }): string;
export function projectOf(name: string): string;
export function summaryAggregates(procs: Array<Record<string, unknown>>): {
  total: number;
  online: number;
  stopped: number;
  memBytes: number;
  cpuPct: number;
};
export function agentHealth(
  procs: Array<Record<string, unknown>>,
  t?: number,
): {
  sano: number;
  inestable: number;
  detenido: number;
  memBytes: number;
  cpuPct: number;
  problems: number;
};
