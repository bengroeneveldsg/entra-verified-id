import React from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Chip,
  Skeleton,
  Alert,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Avatar,
  Divider,
} from '@mui/material';
import {
  Apps as AppsIcon,
  People as PeopleIcon,
  VpnKey as KeyIcon,
  CheckCircle,
  Warning,
  Login as LoginIcon,
  Logout as LogoutIcon,
  ErrorOutline as ErrorIcon,
  Security as SecurityIcon,
  Settings as SettingsIcon,
  History as HistoryIcon,
} from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { samlAppsApi } from '../api/samlApps';
import { sessionsApi } from '../api/sessions';
import { keysApi } from '../api/keys';
import { setupApi } from '../api/setup';
import { auditApi, AuditEntry } from '../api/audit';

interface StatCardProps {
  title: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  sub?: React.ReactNode;
  color?: string;
}

function StatCard({ title, value, icon, sub, color = 'primary.main' }: StatCardProps) {
  return (
    <Card elevation={0} sx={{ border: '1px solid', borderColor: 'divider', height: '100%' }}>
      <CardContent sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="body2" color="text.secondary" fontWeight={500} gutterBottom>
              {title}
            </Typography>
            <Typography variant="h4" fontWeight={700} sx={{ color }}>
              {value}
            </Typography>
            {sub && (
              <Box mt={1}>{sub}</Box>
            )}
          </Box>
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: 2,
              backgroundColor: (t) => `${color}14`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color,
            }}
          >
            {icon}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

function actionIcon(action: string) {
  if (action.startsWith('auth.login_failed')) return <ErrorIcon fontSize="small" />;
  if (action.startsWith('auth.login')) return <LoginIcon fontSize="small" />;
  if (action.startsWith('auth.logout')) return <LogoutIcon fontSize="small" />;
  if (action.startsWith('keys.')) return <KeyIcon fontSize="small" />;
  if (action.startsWith('saml_app.')) return <AppsIcon fontSize="small" />;
  if (action.startsWith('setup.')) return <SettingsIcon fontSize="small" />;
  if (action.startsWith('session.')) return <SecurityIcon fontSize="small" />;
  return <HistoryIcon fontSize="small" />;
}

function actionAvatarColor(action: string): string {
  if (action.includes('failed') || action.includes('disable') || action.includes('revoke')) return '#d32f2f';
  if (action.includes('login') && !action.includes('failed')) return '#2e7d32';
  if (action.includes('rotate') || action.includes('change') || action.includes('update')) return '#e65100';
  return '#1565c0';
}

export default function Dashboard() {
  const { data: setupStatus } = useQuery({
    queryKey: ['setup-status'],
    queryFn: setupApi.getStatus,
  });
  const { data: apps, isLoading: appsLoading } = useQuery({
    queryKey: ['saml-apps'],
    queryFn: samlAppsApi.list,
  });
  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: sessionsApi.list,
  });
  const { data: keyInfo, isLoading: keysLoading } = useQuery({
    queryKey: ['key-info'],
    queryFn: keysApi.getInfo,
  });
  const { data: recentActivity, isLoading: activityLoading } = useQuery({
    queryKey: ['audit-log-recent'],
    queryFn: () => auditApi.list({ limit: 5 }),
  });

  const enabledApps = apps?.filter((a) => a.enabled).length ?? 0;
  const disabledApps = apps ? apps.length - enabledApps : 0;
  const totalApps = apps?.length ?? 0;
  const activeSessions = sessions?.length ?? 0;

  const keyAge = keyInfo?.created_at
    ? (() => {
        try {
          return formatDistanceToNow(parseISO(keyInfo.created_at), { addSuffix: true });
        } catch {
          return keyInfo.created_at;
        }
      })()
    : null;

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} gutterBottom>
        Dashboard
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={3}>
        Overview of your Entra Verified ID deployment.
      </Typography>

      {setupStatus && !setupStatus.onboarding_complete && (
        <Alert severity="warning" icon={<Warning />} sx={{ mb: 3 }}>
          Setup is not complete. Complete the onboarding wizard before using this system in production.
        </Alert>
      )}

      <Grid container spacing={2.5}>
        {/* System Status */}
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="System Status"
            value={setupStatus ? (setupStatus.onboarding_complete ? 'Active' : 'Setup Required') : '—'}
            icon={<CheckCircle />}
            color={setupStatus?.onboarding_complete ? 'success.main' : 'warning.main'}
            sub={
              setupStatus && (
                <Chip
                  label={setupStatus.onboarding_complete ? 'Onboarded' : 'Pending setup'}
                  color={setupStatus.onboarding_complete ? 'success' : 'warning'}
                  size="small"
                />
              )
            }
          />
        </Grid>

        {/* SAML Apps */}
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="SAML Apps"
            value={appsLoading ? <Skeleton width={40} /> : totalApps}
            icon={<AppsIcon />}
            sub={
              apps ? (
                <Typography variant="caption" color="text.secondary">
                  {enabledApps} enabled · {disabledApps} disabled
                </Typography>
              ) : null
            }
          />
        </Grid>

        {/* Active Sessions */}
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Active Sessions"
            value={sessionsLoading ? <Skeleton width={40} /> : activeSessions}
            icon={<PeopleIcon />}
            sub={
              <Typography variant="caption" color="text.secondary">
                Active right now
              </Typography>
            }
          />
        </Grid>

        {/* Signing Key */}
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Signing Key"
            value={keysLoading ? <Skeleton width={80} /> : (keyAge ?? '—')}
            icon={<KeyIcon />}
            sub={
              keyInfo?.kid ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontFamily: 'monospace' }}
                >
                  kid: {keyInfo.kid.slice(0, 12)}…
                </Typography>
              ) : null
            }
          />
        </Grid>

        {/* Recent Activity */}
        <Grid item xs={12}>
          <Card elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                Recent Activity
              </Typography>
              {activityLoading ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} height={48} />
                  ))}
                </Box>
              ) : recentActivity && recentActivity.length > 0 ? (
                <List disablePadding>
                  {recentActivity.map((entry: AuditEntry, idx: number) => (
                    <React.Fragment key={entry.sk}>
                      <ListItem disableGutters sx={{ py: 0.75 }}>
                        <ListItemAvatar>
                          <Avatar
                            sx={{
                              width: 36,
                              height: 36,
                              bgcolor: actionAvatarColor(entry.action),
                            }}
                          >
                            {actionIcon(entry.action)}
                          </Avatar>
                        </ListItemAvatar>
                        <ListItemText
                          primary={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography variant="body2" fontWeight={600} sx={{ fontFamily: 'monospace' }}>
                                {entry.action}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                by {entry.actor}
                              </Typography>
                            </Box>
                          }
                          secondary={
                            <Typography variant="caption" color="text.secondary">
                              {entry.target && entry.target !== '—' ? `${entry.target} · ` : ''}
                              {(() => {
                                try {
                                  return formatDistanceToNow(parseISO(entry.timestamp), { addSuffix: true });
                                } catch {
                                  return entry.timestamp;
                                }
                              })()}
                            </Typography>
                          }
                        />
                      </ListItem>
                      {idx < recentActivity.length - 1 && <Divider component="li" />}
                    </React.Fragment>
                  ))}
                </List>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  No recent activity.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
