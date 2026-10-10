import axios from 'axios';

// Sessions ride on the session cookie only (SameSite=Lax, see
// server/src/session.ts): no token is stored or sent by the client.
const apiClient = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Response interceptor: a 401 means the session is gone — back to the login
// page. A 403 2FA_SETUP_REQUIRED (Force 2FA turned on while signed in) flags
// the session so ProtectedRoute sends the user to the 2FA setup.
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    if (error.response?.status === 403 && error.response?.data?.code === '2FA_SETUP_REQUIRED') {
      // Lazy import avoids the client.ts <-> authStore.ts (via auth.api.ts) cycle at module init.
      void import('../store/authStore').then(({ useAuthStore }) => {
        if (!useAuthStore.getState().requires2faSetup) useAuthStore.setState({ requires2faSetup: true });
      });
    }
    return Promise.reject(error);
  },
);

export default apiClient;
