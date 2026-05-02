import { apiClient } from './client';

export interface AuditEntry {
  pk: string;
  sk: string;     // sort key: "{timestamp}#{uuid}" — unique row ID
  actor: string;
  action: string;
  target: string;
  details: string;
  timestamp: string;
  sourceIp?: string;
  userAgent?: string;
}

export interface AuditQueryParams {
  actor?: string;
  from_ts?: string;
  to_ts?: string;
  limit?: number;
}

export const auditApi = {
  list: (params?: AuditQueryParams) =>
    apiClient.get<AuditEntry[]>('/audit/', { params }).then((r) => r.data),
  getRuntimeLogs: (minutes?: number, log_group?: string) =>
    apiClient
      .get('/audit/runtime', { params: { minutes, log_group } })
      .then((r) => r.data),
};
