import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

// Must match REQUIRED_ENROLLMENT_VERSION in server/src/controllers/enrollment.controller.ts
const REQUIRED_ENROLLMENT_VERSION = 2;

interface ProtectedRouteProps {
  /** Hard role gate: only users with this exact platform role pass. */
  requiredRole?: string;
  /**
   * Capability gate (any-of, Obliance pattern): passes for a platform admin,
   * a tenant 'admin' on the active tenant, or a user whose tenantCapabilities
   * (resolved server-side from the permission_set of user_tenants.role)
   * contain at least one of these. Both gates apply when both are given.
   */
  requiredCapabilities?: string[];
}

export function ProtectedRoute({ requiredRole, requiredCapabilities }: ProtectedRouteProps) {
  const { user, isInitialized, permissions, permissionsStatus, refreshPermissions, hasAnyCapability, requires2faSetup } = useAuthStore();
  // Re-render when the tenant list (and so the tenant role) arrives.
  useTenantStore((s) => s.tenants);
  const location = useLocation();

  // A capability-gated route with no permissions loaded and no load in
  // flight: load them (once — a failure leaves 'error', handled below).
  const needsCapabilities = !!user && user.role !== 'admin' && !!requiredCapabilities?.length;
  useEffect(() => {
    if (needsCapabilities && !permissions && permissionsStatus === 'idle') void refreshPermissions();
  }, [needsCapabilities, permissions, permissionsStatus, refreshPermissions]);

  if (!isInitialized) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-primary">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Redirect to enrollment if user hasn't completed the required enrollment version.
  // Skip the check when already on /enroll to prevent a redirect loop,
  // and skip it for Obligate SSO users (onboarding is managed by Gate).
  // ObliTools is no exception any more: the session is the first-party
  // SameSite=Lax cookie only (no X-Auth-Token bridge), so a signed-in user
  // there has a working cookie and goes through enrollment like everyone.
  if (
    user.foreignSource !== 'obligate' &&
    (user.enrollmentVersion ?? 0) < REQUIRED_ENROLLMENT_VERSION &&
    location.pathname !== '/enroll'
  ) {
    return <Navigate to="/enroll" replace />;
  }

  // "Force 2FA" (Settings): a local account without any second factor is
  // kept on its profile until one is enabled — the API answers 403
  // 2FA_SETUP_REQUIRED elsewhere (server/src/middleware/require2faSetup.ts).
  // Obligate SSO users are exempt (their 2FA is enforced by Obligate), and
  // the enrollment wizard (which offers TOTP) is left alone.
  if (
    requires2faSetup &&
    user.foreignSource !== 'obligate' &&
    location.pathname !== '/profile' &&
    location.pathname !== '/enroll'
  ) {
    return <Navigate to="/profile?setup2fa=1" replace />;
  }

  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to="/" replace />;
  }

  if (requiredCapabilities && requiredCapabilities.length > 0 && user.role !== 'admin') {
    // Right after login() the permissions (and their tenantCapabilities)
    // arrive a moment after the user (background /auth/me): wait for them
    // instead of bouncing a deep link. A failed load falls through to the
    // gate (tenant admins still pass via the tenant role), never spins forever.
    if (!permissions && permissionsStatus !== 'error') {
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <LoadingSpinner size="lg" />
        </div>
      );
    }
    if (!hasAnyCapability(requiredCapabilities)) {
      return <Navigate to="/" replace />;
    }
  }

  return <Outlet />;
}
