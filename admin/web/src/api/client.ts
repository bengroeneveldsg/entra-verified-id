/**
 * Axios instance pre-configured for the admin API.
 * All requests are relative to /api/admin and include credentials (cookies).
 */
import axios from 'axios';

export const apiClient = axios.create({
  baseURL: '/api/admin',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Redirect to /login on 401, but not during the setup wizard or login page
apiClient.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      const path = window.location.pathname;
      if (path !== '/login' && path !== '/setup' && !path.startsWith('/setup')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);
