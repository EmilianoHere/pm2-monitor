/**
 * Wire protocol version. The agent sends this in `register`; the server rejects
 * a mismatch with a `register:nack` (VERSION_MISMATCH). Bump on any
 * incompatible frame change.
 */
export const PROTOCOL_VERSION = 1;
