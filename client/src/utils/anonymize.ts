import { useAuthStore } from '@/store/authStore';

/**
 * Returns true if anonymous mode is currently enabled for the logged-in user.
 */
export function isAnonymousMode(): boolean {
  return useAuthStore.getState().user?.preferences?.anonymousMode === true;
}

/**
 * Mask sensitive text when anonymous mode is active.
 * If anonymous mode is off, returns the text unchanged.
 *
 * Usage:
 *   <span>{anonymize(device.hostname)}</span>
 *   <span>{anonymizeIp(device.ip)}</span>
 */
export function anonymize(text: string | null | undefined): string {
  if (!text) return '';
  if (!isAnonymousMode()) return text;
  // Replace with dots of similar length, keeping first char visible
  if (text.length <= 2) return '••';
  return text[0] + '•'.repeat(Math.min(text.length - 1, 12));
}

/**
 * Mask an IP address: 192.168.1.100 → 192.•••.•.•••
 */
export function anonymizeIp(ip: string | null | undefined): string {
  if (!ip) return '';
  if (!isAnonymousMode()) return ip;
  // IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts[0] + '.' + parts.slice(1).map(p => '•'.repeat(p.length)).join('.');
  }
  // IPv6 — mask everything after first segment
  if (ip.includes(':')) {
    const first = ip.split(':')[0];
    return first + ':••••:••••:••••';
  }
  return anonymize(ip);
}

/**
 * Mask a MAC address: AA:BB:CC:DD:EE:FF → AA:BB:••:••:••:••
 */
export function anonymizeMac(mac: string | null | undefined): string {
  if (!mac) return '';
  if (!isAnonymousMode()) return mac;
  const sep = mac.includes(':') ? ':' : '-';
  const parts = mac.split(sep);
  if (parts.length < 4) return anonymize(mac);
  return parts.slice(0, 2).join(sep) + sep + parts.slice(2).map(() => '••').join(sep);
}

/**
 * Mask a URL/path: https://internal.corp/api → https://•••••••••/•••
 */
export function anonymizeUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (!isAnonymousMode()) return url;
  try {
    const u = new URL(url);
    return `${u.protocol}//` + anonymize(u.hostname) + '/•••';
  } catch {
    return anonymize(url);
  }
}

/**
 * Mask a username: admin → a••••
 */
export function anonymizeUsername(username: string | null | undefined): string {
  if (!username) return '';
  if (!isAnonymousMode()) return username;
  if (username.length <= 1) return '•';
  return username[0] + '•'.repeat(Math.min(username.length - 1, 8));
}
