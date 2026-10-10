import crypto from 'crypto';

// Identifier of one express session in memory, in logs and in Socket.io
// rooms: the sha256 of its id. The raw id is the secret part of the session
// cookie, so it is never kept or logged outside the session store. No
// project import: safe for socket.ts.

/** sha256 (hex) of an express-session id. */
export function sessionHash(sid: string): string {
  return crypto.createHash('sha256').update(String(sid)).digest('hex');
}

/** Socket.io room of one express session. */
export function sessionRoom(sid: string): string {
  return `sess:${sessionHash(sid)}`;
}
