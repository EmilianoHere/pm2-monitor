/**
 * Entry point stub.
 *
 * The full boot sequence (config -> logger -> alert rules -> MonitorState +
 * MetricsStore + ErrorTracker -> channels -> AlertEngine -> Pm2Client ->
 * Express server + WsHub -> listen -> digest scheduler, plus graceful shutdown)
 * is implemented in FEAT-004. This stub exists so `tsc` has an entry and the
 * build succeeds for the foundation layer (FEAT-001).
 */

export async function bootstrap(): Promise<void> {
  // Wired up in FEAT-004.
}
