/**
 * Log reads.
 *
 * The only log endpoint in the REST surface is `GET /api/processes/:name/logs`,
 * which must resolve `:name` against the snapshot map before reading (404 for an
 * unknown process). That resolution lives alongside the other `:name` routes in
 * `routes/processes.ts`, so there is no separate `/api/logs` router to mount —
 * this module exists to document that placement and to keep the file layout in
 * step with the design's module list.
 *
 * REST `GET /logs` filters server-side (`?q`, `?level`) over the tail slice it
 * reads; the WS live tail is filtered only by stream selection (see ws/hub.ts).
 */

export {};
