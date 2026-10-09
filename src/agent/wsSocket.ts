/**
 * Production {@link AgentSocketFactory} backed by the already-present `ws`
 * package (NFR-5: no new runtime dependency). Kept separate from
 * `connection.ts` so the connection state machine stays free of the `ws` import
 * and remains unit-testable with a fake socket.
 */

import { WebSocket } from 'ws';
import type { AgentSocket, AgentSocketFactory } from './connection.js';

/** Builds an outbound `ws` WebSocket wrapped in the narrow AgentSocket surface. */
export const createWsSocketFactory: () => AgentSocketFactory = () => (opts) => {
  const ws = new WebSocket(opts.url, { rejectUnauthorized: opts.rejectUnauthorized });
  const socket: AgentSocket = {
    on(event: string, listener: (...args: never[]) => void): void {
      // The AgentSocket events map 1:1 onto the ws WebSocket events.
      ws.on(event, listener as (...args: unknown[]) => void);
    },
    send(data: string): void {
      ws.send(data);
    },
    ping(): void {
      ws.ping();
    },
    close(): void {
      ws.close();
    },
    terminate(): void {
      ws.terminate();
    },
  } as AgentSocket;
  return socket;
};
