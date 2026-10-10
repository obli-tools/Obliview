/** Server `error` message of a failed API call, or `fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/** Machine-readable `code` of a failed API call (AppError code), if any. */
export function apiErrorCode(err: unknown): string | undefined {
  const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof code === 'string' ? code : undefined;
}
