import { apiClient } from './client';

export const authApi = {
  login: (data: { username: string; password: string; totp_code?: string }) =>
    apiClient.post('/auth/login', data).then((r) => r.data),

  logout: () => apiClient.post('/auth/logout').then((r) => r.data),

  changePassword: (data: { current_password: string; new_password: string }) =>
    apiClient.post('/auth/change-password', data).then((r) => r.data),

  enrollMfa: () => apiClient.get('/auth/enroll-mfa').then((r) => r.data),

  verifyMfa: (totp_code: string) =>
    apiClient.post('/auth/verify-mfa', { totp_code }).then((r) => r.data),
};
