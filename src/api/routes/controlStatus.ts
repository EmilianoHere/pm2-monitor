/**
 * Shared HTTP status mapping for a routed-command {@link ControlResult} code on
 * the FLEET path (the agents routes). Routed-command failures arrive as
 * not-ok ControlResult values resolved from `FleetRegistry.routeControl`, not as
 * thrown apiErrors, so the agents routes map codes to HTTP themselves via this
 * table rather than overloading the binary standalone `sendControlResult`.
 *
 * The standalone `sendControlResult` in `src/api/routes/processes.ts` is left
 * UNCHANGED (binary PM2_UNAVAILABLE?409:502) — standalone never produces the
 * richer VALIDATION/AGENT_* codes, so only the fleet path needs this.
 */

/**
 * Maps a ControlResult failure code to its HTTP status:
 *  - 409 for PM2_UNAVAILABLE / AGENT_OFFLINE / AGENT_TIMEOUT (transient/retryable)
 *  - 404 for AGENT_NOT_FOUND
 *  - 400 for VALIDATION
 *  - 502 for PM2_ERROR and any unmapped/default code
 */
export function statusForControlCode(code: string): number {
  switch (code) {
    case 'PM2_UNAVAILABLE':
    case 'AGENT_OFFLINE':
    case 'AGENT_TIMEOUT':
      return 409;
    case 'AGENT_NOT_FOUND':
      return 404;
    case 'VALIDATION':
      return 400;
    case 'PM2_ERROR':
    default:
      return 502;
  }
}
