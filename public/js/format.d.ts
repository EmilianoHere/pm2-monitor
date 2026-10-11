// Type declarations for format.js so the src/webui/*.test.ts specs type-check
// under strict `tsc`. The runtime module is plain browser ES JavaScript; this
// sibling .d.ts is never emitted and never bundled.
export function fmtBytes(bytes: number): string;
export function fmtBytesTotal(bytes: number): string;
export function fmtUptime(ms: number | null | undefined): string;
export function fmtRelativeAge(epochMs: number | null | undefined): string;
