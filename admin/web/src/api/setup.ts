import { apiClient } from './client';

export interface SetupStatus {
  onboarding_complete: boolean;
  current_step: number;
  has_bootstrap_secret: boolean;
}

export const setupApi = {
  getStatus: () => apiClient.get<SetupStatus>('/setup/status').then((r) => r.data),

  createAdminUser: (data: { email: string; password: string }, token: string) =>
    apiClient.post('/setup/admin-user', data, {
      headers: { 'X-Bootstrap-Token': token },
    }).then((r) => r.data),

  configureTenant: (data: {
    tenant_id: string;
    issuer_verifier_client_id: string;
    issuer_verifier_client_secret: string;
  }) => apiClient.post('/setup/tenant', data).then((r) => r.data),

  configureDid: (data: {
    authority: string;
    manifest_url: string;
    accepted_issuer: string;
  }) => apiClient.post('/setup/did', data).then((r) => r.data),

  configureDomain: (data: {
    public_domain: string;
    api_domain: string;
    frontend_base_url: string;
    client_name: string;
  }) => apiClient.post('/setup/domain', data).then((r) => r.data),

  configureKeys: (data: { generate_new: boolean; existing_pem?: string }) =>
    apiClient.post('/setup/keys', data).then((r) => r.data),

  completeSetup: () => apiClient.post('/setup/complete').then((r) => r.data),
};
