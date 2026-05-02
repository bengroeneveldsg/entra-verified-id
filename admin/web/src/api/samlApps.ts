import { apiClient } from './client';

export interface SamlApp {
  appId: string;
  spEntityId: string;
  acsUrl: string;
  relayState: string;
  roleArn: string;
  providerArn: string;
  sessionName: string;
  sessionDuration: number;
  displayName: string;
  description: string;
  allowedGroupIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSamlAppRequest {
  spEntityId: string;
  acsUrl: string;
  relayState?: string;
  roleArn: string;
  providerArn: string;
  sessionName?: string;
  sessionDuration?: number;
  displayName: string;
  description?: string;
  allowedGroupIds?: string[];
}

export interface UpdateSamlAppRequest {
  acsUrl?: string;
  relayState?: string;
  roleArn?: string;
  providerArn?: string;
  sessionName?: string;
  sessionDuration?: number;
  displayName?: string;
  description?: string;
  allowedGroupIds?: string[];
  enabled?: boolean;
}

export const samlAppsApi = {
  list: () => apiClient.get<SamlApp[]>('/saml-apps/').then((r) => r.data),
  get: (appId: string) => apiClient.get<SamlApp>(`/saml-apps/${appId}`).then((r) => r.data),
  create: (data: CreateSamlAppRequest) =>
    apiClient.post<SamlApp>('/saml-apps/', data).then((r) => r.data),
  update: (appId: string, data: UpdateSamlAppRequest) =>
    apiClient.patch<SamlApp>(`/saml-apps/${appId}`, data).then((r) => r.data),
  delete: (appId: string) =>
    apiClient.delete(`/saml-apps/${appId}`).then((r) => r.data),
};
