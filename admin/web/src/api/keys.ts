import { apiClient } from './client';

export interface KeyInfo {
  kid: string | null;
  created_at: string | null;
  jwks_url: string;
  oidc_config_url: string;
}

export const keysApi = {
  getInfo: () => apiClient.get<KeyInfo>('/keys/').then((r) => r.data),
  rotate: () => apiClient.post('/keys/rotate').then((r) => r.data),
};
