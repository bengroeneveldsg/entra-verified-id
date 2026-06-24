import { apiClient } from './client';

export interface SamlAttribute {
  name: string;
  nameFormat: string;
  source: 'claim' | 'static';
  value: string;
}

export interface NameIdConfig {
  format: string;
  source: 'claim' | 'static';
  value: string;
}

export interface SamlApp {
  appId: string;
  spEntityId: string;
  acsUrl: string;
  relayState: string;
  // Legacy AWS fields — may be absent on apps created via the new attribute editor
  roleArn?: string | null;
  providerArn?: string | null;
  sessionName?: string;
  sessionDuration?: number;
  displayName: string;
  description: string;
  allowedGroupIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  // Generic attribute mapping (blank by default on new apps)
  attributes?: SamlAttribute[];
  nameId?: NameIdConfig | null;
}

export interface CreateSamlAppRequest {
  spEntityId: string;
  acsUrl: string;
  relayState?: string;
  displayName: string;
  description?: string;
  allowedGroupIds?: string[];
  attributes?: SamlAttribute[];
  nameId?: NameIdConfig | null;
}

export interface UpdateSamlAppRequest {
  acsUrl?: string;
  relayState?: string;
  displayName?: string;
  description?: string;
  allowedGroupIds?: string[];
  enabled?: boolean;
  attributes?: SamlAttribute[];
  nameId?: NameIdConfig | null;
}

export interface EntraGroup {
  id: string;
  displayName: string;
  description: string;
}

// VID claim keys available for use as attribute / NameID sources
export const VID_CLAIMS = [
  { value: 'displayName',       label: 'displayName — Full name' },
  { value: 'givenName',         label: 'givenName — First name' },
  { value: 'surname',           label: 'surname — Last name' },
  { value: 'mail',              label: 'mail — Email address' },
  { value: 'userPrincipalName', label: 'userPrincipalName — UPN' },
  { value: 'jobTitle',          label: 'jobTitle — Job title' },
  { value: 'department',        label: 'department — Department' },
  { value: 'employeeId',        label: 'employeeId — Employee ID' },
] as const;

export const NAMEID_FORMATS = [
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', label: 'emailAddress (default)' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',   label: 'persistent' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',    label: 'transient' },
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',  label: 'unspecified' },
] as const;

export const samlAppsApi = {
  list: () => apiClient.get<SamlApp[]>('/saml-apps/').then((r) => r.data),
  get: (appId: string) => apiClient.get<SamlApp>(`/saml-apps/${appId}`).then((r) => r.data),
  create: (data: CreateSamlAppRequest) =>
    apiClient.post<SamlApp>('/saml-apps/', data).then((r) => r.data),
  update: (appId: string, data: UpdateSamlAppRequest) =>
    apiClient.patch<SamlApp>(`/saml-apps/${appId}`, data).then((r) => r.data),
  delete: (appId: string) =>
    apiClient.delete(`/saml-apps/${appId}`).then((r) => r.data),
  searchGroups: (q: string) =>
    apiClient.get<EntraGroup[]>('/saml-apps/groups/search', { params: { q } }).then((r) => r.data),
  resolveGroups: (ids: string[]) =>
    apiClient.post<EntraGroup[]>('/saml-apps/groups/resolve', ids).then((r) => r.data),
};
