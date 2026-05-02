import { apiClient } from './client';

export interface VidSession {
  requestId: string;
  status: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
  claims?: {
    displayName?: string;
    [key: string]: unknown;
  };
}

export const sessionsApi = {
  list: () => apiClient.get<VidSession[]>('/sessions/').then((r) => r.data),
  revoke: (requestId: string) =>
    apiClient.delete(`/sessions/${requestId}`).then((r) => r.data),
};
