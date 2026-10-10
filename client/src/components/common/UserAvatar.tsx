import { cn } from '@/utils/cn';

interface UserAvatarProps {
  /** Profile photo URL (synced from Obligate). Null/undefined renders the gradient initial fallback. */
  avatar?: string | null;
  /** Username — used for the initial-letter fallback. */
  username: string;
  /** Pixel size; the component is always a square circle. */
  size?: number;
  className?: string;
}

/**
 * Round avatar — image when available, gradient circle with the first
 * uppercase letter of the username otherwise. Same visual the chat panel and
 * the rest of the Obli suite use, so users without an avatar look consistent
 * across the apps.
 */
export function UserAvatar({ avatar, username, size = 26, className }: UserAvatarProps) {
  const initial = (username?.startsWith('og_') ? username.slice(3) : username || '?')
    .charAt(0)
    .toUpperCase();
  const dim = `${size}px`;
  const fontSize = `${Math.max(9, Math.round(size * 0.42))}px`;

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={username}
        className={cn('rounded-full object-cover shrink-0', className)}
        style={{ width: dim, height: dim }}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        className,
      )}
      style={{
        width: dim,
        height: dim,
        fontSize,
        background: 'linear-gradient(135deg, rgba(43,196,189,0.6), rgba(95,217,211,0.4))',
      }}
    >
      {initial}
    </div>
  );
}
