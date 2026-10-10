import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useNativeTopOffset } from '@/hooks/useNativeTopOffset';
import { useIsMasterTenant } from '@/hooks/useIsGodView';
import { ConfirmProvider } from '@/components/common/ConfirmDialog';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoginPage } from '@/pages/LoginPage';
import { EnrollmentPage } from '@/pages/EnrollmentPage';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { MonitorDetailPage } from '@/pages/MonitorDetailPage';
import { MonitorEditPage } from '@/pages/MonitorEditPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AdminUsersPage } from '@/pages/AdminUsersPage';
import { AdminAgentPage } from '@/pages/AdminAgentPage';
import AgentListPage from '@/pages/AgentListPage';
import { AgentDetailPage } from '@/pages/AgentDetailPage';
import PoliciesPage from '@/pages/PoliciesPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { GroupDetailPage } from '@/pages/GroupDetailPage';
import { GroupEditPage } from '@/pages/GroupEditPage';
import { DownloadPage } from '@/pages/DownloadPage';
import { AdminTenantsPage } from '@/pages/AdminTenantsPage';
import { SecurityPage } from '@/pages/SecurityPage';
import MonitorListPage from '@/pages/MonitorListPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import '@/i18n';

/**
 * Workspace administration (/workspace): platform admin on the master tenant
 * only — child workspaces are managed from there. Everyone else goes home.
 */
function MasterTenantRoute() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const isMaster = useIsMasterTenant();

  // Right after login() the active tenant arrives a moment after the user
  // (background /auth/me): wait for it instead of bouncing a deep link.
  if (isAdmin && currentTenantId == null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <LoadingSpinner size="lg" />
      </div>
    );
  }
  if (!isAdmin || !isMaster) return <Navigate to="/" replace />;
  return <Outlet />;
}

export default function App() {
  const { checkSession } = useAuthStore();
  const nativeTop = useNativeTopOffset();

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        {/* Protected routes */}
        <Route element={<ProtectedRoute />}>
          {/* Enrollment — full-screen, outside AppLayout */}
          <Route path="/enroll" element={<EnrollmentPage />} />
          <Route element={<AppLayout />}>
            <Route path="/" element={<DashboardPage />} />
            {/* Flat monitor list: every signed-in user (server-side visibility). */}
            <Route path="/monitors" element={<MonitorListPage />} />
            <Route path="/download" element={<DownloadPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/monitor/new" element={<MonitorEditPage />} />
            <Route path="/monitor/:id" element={<MonitorDetailPage />} />
            <Route path="/monitor/:id/edit" element={<MonitorEditPage />} />
            <Route path="/group/:id" element={<GroupDetailPage />} />
            <Route path="/group/:id/edit" element={<GroupEditPage />} />

            {/* Legacy URLs (bookmarks, ObliTools LastURL, old e-mails) →
                their place in the current navigation. The target route
                applies its own guard. */}
            <Route path="/groups" element={<Navigate to="/" replace />} />
            <Route path="/notifications" element={<Navigate to="/policies?tab=notifications" replace />} />
            <Route path="/manage/remediations" element={<Navigate to="/policies?tab=remediations" replace />} />
            <Route path="/manage/maintenance" element={<Navigate to="/policies?tab=maintenance" replace />} />
            <Route path="/manage/tenants" element={<Navigate to="/workspace" replace />} />
            <Route path="/manage/import-export" element={<Navigate to="/settings#import-export" replace />} />

            {/* Agents: every signed-in user. The server decides what each
                one sees (visible agent monitors) and may do (agents.manage,
                RW on the agent monitor). /agents/:deviceId must not change:
                Obligate registers it as the device link and ObliTools stores
                it as LastURL. */}
            <Route path="/agents" element={<AgentListPage />} />
            <Route path="/agents/:deviceId" element={<AgentDetailPage />} />

            {/* Capability-gated routes (Obliance pattern): platform admin,
                tenant 'admin', or any of the listed tenant capabilities. */}
            <Route element={<ProtectedRoute requiredCapabilities={['notifications', 'remediation', 'maintenance']} />}>
              <Route path="/policies" element={<PoliciesPage />} />
            </Route>
            <Route element={<ProtectedRoute requiredCapabilities={['users.manage']} />}>
              <Route path="/manage/users" element={<AdminUsersPage />} />
            </Route>
            <Route element={<ProtectedRoute requiredCapabilities={['agents.manage']} />}>
              <Route path="/manage/agents" element={<AdminAgentPage />} />
            </Route>
            {/* Security (audit log): 'supervision:read'. */}
            <Route element={<ProtectedRoute requiredCapabilities={['supervision:read']} />}>
              <Route path="/manage/security" element={<SecurityPage />} />
            </Route>
            <Route element={<ProtectedRoute requiredCapabilities={['settings']} />}>
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            {/* Workspace administration: platform admin on the master tenant. */}
            <Route element={<ProtectedRoute requiredRole="admin" />}>
              <Route element={<MasterTenantRoute />}>
                <Route path="/workspace" element={<AdminTenantsPage />} />
              </Route>
            </Route>
          </Route>
        </Route>

        {/* 404 */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>

      <Toaster
        position="top-right"
        // ObliTools tab-bar offset (0 in a browser) + safe-area insets
        // (status bar / notch / gesture bar in the Android shell). On desktop
        // browsers these resolve to react-hot-toast's own 16 px defaults.
        containerStyle={{
          top: `calc(${nativeTop ? nativeTop + 8 : 16}px + var(--safe-top))`,
          right: 'calc(16px + var(--safe-right))',
          bottom: 'calc(16px + var(--safe-bottom))',
          left: 'calc(16px + var(--safe-left))',
        }}
        toastOptions={{
          className: '!bg-bg-secondary !text-text-primary !border !border-transparent',
          duration: 4000,
        }}
      />
      {/* Host for useConfirm() / usePrompt() / confirmDialog() / promptDialog()
          — replaces window.confirm / window.prompt. */}
      <ConfirmProvider />
    </BrowserRouter>
  );
}
