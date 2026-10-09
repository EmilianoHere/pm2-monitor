/**
 * Agent-token validation for the inbound AgentGateway. Agents present a
 * credential in their `register` frame; the server compares it against a
 * configured token set using the SAME throw-safe {@link safeEqual} the REST and
 * human-WS auth use. The agent credential space is SEPARATE from the human
 * API_KEY/BASIC auth (different env vars, compared here, never cross-checked).
 *
 * A token LIST (not a single token) enables rotation: an operator can add a new
 * token and remove the old one without a flag day — any entry that matches
 * accepts the agent (AC-50).
 */

import { safeEqual } from '../api/auth.js';
import type { AppConfig } from '../config/env.js';

/** The derived agent-auth config: the set of currently-accepted tokens. */
export interface AgentAuthConfig {
  tokens: string[];
}

/**
 * True iff `provided` matches any configured token. Each comparison goes
 * through `safeEqual`, which sha256-normalizes both sides before
 * `timingSafeEqual`, so a missing/empty/wrong-length credential returns false
 * and NEVER throws (AC-23/48/49). An empty token list yields false.
 */
export function validate(provided: string, tokens: string[]): boolean {
  return tokens.some((t) => safeEqual(provided, t));
}

/**
 * Derives the accepted-token set from config, mirroring `buildAuthConfig`/
 * `buildSmtpConfig`: split `AGENT_TOKENS` on ',', trim, drop empties, append
 * `AGENT_TOKEN` if set, and dedupe. The env schema's superRefine guarantees at
 * least one of the two is present in server mode, so the result is non-empty
 * there.
 */
export function buildAgentAuthConfig(cfg: Pick<AppConfig, 'AGENT_TOKENS' | 'AGENT_TOKEN'>): AgentAuthConfig {
  const tokens: string[] = [];
  if (cfg.AGENT_TOKENS) {
    for (const raw of cfg.AGENT_TOKENS.split(',')) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) tokens.push(trimmed);
    }
  }
  if (cfg.AGENT_TOKEN) {
    const trimmed = cfg.AGENT_TOKEN.trim();
    if (trimmed.length > 0) tokens.push(trimmed);
  }
  return { tokens: [...new Set(tokens)] };
}
