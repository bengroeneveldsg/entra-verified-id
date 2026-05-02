import { apiClient } from './client';

export interface ConfigItem {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string;
  read_only?: boolean;
}

export const configApi = {
  list: () => apiClient.get<ConfigItem[]>('/config/').then((r) => r.data),
  update: (key: string, value: string) =>
    apiClient.put<ConfigItem>('/config/', { key, value }).then((r) => r.data),
};
