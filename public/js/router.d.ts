// Type declarations for router.js so the src/webui/*.test.ts specs type-check
// under strict `tsc`. The runtime module is plain browser ES JavaScript; this
// sibling .d.ts is never emitted and never bundled. Only the pure
// parseHash/buildHash helpers are declared (the Router class is DOM-bound and
// not imported by the specs).
export interface Route {
  view: 'processes' | 'fleet' | 'settings' | null;
  agentId: string | null;
  name: string | null;
  filter: 'problems' | null;
}

export function parseHash(hash: string): Route;

export function buildHash(route: {
  view: string | null;
  agentId?: string | null;
  name?: string | null;
  filter?: string | null;
}): string;
