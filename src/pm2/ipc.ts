/**
 * Inherited IPC channel neutralization.
 *
 * When pm2-monitor is launched as a PM2 child (`pm2 start ecosystem.config.cjs`,
 * fork mode) the process inherits PM2's IPC channel: PM2 sets NODE_CHANNEL_FD
 * (typically 3) so Node wires up `process.channel` / `process.send`. The `pm2`
 * client library opens its OWN RPC channel on connect; that collides with the
 * inherited parent channel and `pingDaemon`/`pm2.connect()` hang forever. We
 * neutralize the inherited channel BEFORE the pm2 client connects so the client
 * owns a clean RPC path.
 *
 * The detector is split into a pure decision function (unit-tested, no process
 * access) and a thin side-effecting wrapper that reads live process signals.
 */

import type { Logger } from '../core/logger.js';

/** The outcome of the inherited-IPC check: whether to neutralize and why. */
export interface IpcNeutralizeDecision {
  neutralize: boolean;
  reason: string;
}

/**
 * Pure decision: given the environment plus whether `process.channel` and
 * `process.send` are present, decide whether an inherited IPC channel must be
 * neutralized. No process access — fully deterministic for tests.
 *
 * Neutralize when any one of these inherited-channel signals fires:
 *  - env.NODE_CHANNEL_FD is a non-empty string (PM2 fork mode sets this),
 *  - process.channel is present,
 *  - process.send is present.
 */
export function shouldNeutralizeInheritedIpc(
  env: NodeJS.ProcessEnv,
  hasChannel: boolean,
  hasSend: boolean,
): IpcNeutralizeDecision {
  const channelFd = env.NODE_CHANNEL_FD;
  if (typeof channelFd === 'string' && channelFd.length > 0) {
    return { neutralize: true, reason: `NODE_CHANNEL_FD=${channelFd}` };
  }
  if (hasChannel) {
    return { neutralize: true, reason: 'process.channel present' };
  }
  if (hasSend) {
    return { neutralize: true, reason: 'process.send present' };
  }
  return { neutralize: false, reason: 'no inherited IPC channel' };
}

/**
 * Reads live process signals, applies {@link shouldNeutralizeInheritedIpc}, and
 * when neutralization is required `unref()`s the inherited IPC channel.
 *
 * `channel.unref()` CHANGES process behavior in exactly one, safe way: the
 * inherited channel no longer keeps the event loop alive, so it cannot by
 * itself hold the process up or wedge the pm2 client's connect. It is only
 * invoked because an inherited channel has been positively confirmed.
 *
 * We deliberately do NOT call `process.disconnect()`: in PM2 fork mode the
 * inherited channel IS PM2's own management/keepalive channel to the child, and
 * closing it makes PM2 treat the child as gone and restart it in a tight loop.
 * Unref-ing leaves PM2's channel intact while removing its hold on the loop,
 * which is sufficient — the pm2 client reaches the daemon over its own separate
 * socket, not this channel.
 */
export function neutralizeInheritedIpc(logger: Logger): IpcNeutralizeDecision {
  const hasChannel = Boolean((process as { channel?: unknown }).channel);
  const hasSend = typeof process.send === 'function';
  const decision = shouldNeutralizeInheritedIpc(process.env, hasChannel, hasSend);
  if (!decision.neutralize) return decision;

  logger.info('neutralizing inherited IPC channel before pm2 connect', { reason: decision.reason });
  try {
    (process as { channel?: { unref?: () => void } }).channel?.unref?.();
  } catch (err) {
    logger.debug('channel.unref() threw during IPC neutralization', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return decision;
}
