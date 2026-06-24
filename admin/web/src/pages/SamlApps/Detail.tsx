import React from 'react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Chip,
  CircularProgress,
  IconButton,
} from '@mui/material';
import { ArrowBack, Edit as EditIcon } from '@mui/icons-material';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTheme, alpha } from '@mui/material/styles';
import { format, parseISO } from 'date-fns';
import { samlAppsApi, SamlApp, EntraGroup, NAMEID_FORMATS } from '../../api/samlApps';
import { STATUS_DOT_COLORS } from '../../components/TableStyles';

function StatusDot({ enabled }: { enabled: boolean }) {
  const key = enabled ? 'enabled' : 'disabled';
  const { dot, text, bg } = STATUS_DOT_COLORS[key];
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        px: '7px',
        py: '2px',
        borderRadius: '4px',
        backgroundColor: bg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: text,
        lineHeight: 1.6,
      }}
    >
      <Box
        component="span"
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: dot,
          flexShrink: 0,
        }}
      />
      {enabled ? 'Enabled' : 'Disabled'}
    </Box>
  );
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 'none' } }}>
      <Typography variant="body2" color="text.secondary" fontWeight={500}>{label}</Typography>
      <Typography variant="body2" sx={mono ? { fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' } : {}}>{value}</Typography>
    </Box>
  );
}

function formatSessionDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.length > 0 ? parts.join(' ') : '0m';
}

function formatDate(iso: string): string {
  try {
    return format(parseISO(iso), 'dd MMM yyyy HH:mm:ss');
  } catch {
    return iso;
  }
}

const sectionPaperSx = {
  elevation: 0,
  sx: {
    border: '1px solid',
    borderColor: 'divider',
    borderRadius: 2,
    p: 2.5,
    mb: 2,
  },
} as const;

export function SamlAppDetail() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const theme = useTheme();

  const { data: app, isLoading, isError, error } = useQuery<SamlApp>({
    queryKey: ['saml-app', appId],
    queryFn: () => samlAppsApi.get(appId!),
    enabled: !!appId,
    retry: (failureCount, err: any) => {
      if (err?.response?.status === 404) return false;
      return failureCount < 2;
    },
  });

  const { data: resolvedGroups } = useQuery<EntraGroup[]>({
    queryKey: ['resolve-groups', app?.allowedGroupIds],
    queryFn: () => samlAppsApi.resolveGroups(app!.allowedGroupIds),
    enabled: !!app?.allowedGroupIds?.length,
    staleTime: 5 * 60_000,
  });

  const groupById = Object.fromEntries((resolvedGroups ?? []).map((g) => [g.id, g]));

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !app) {
    const is404 = (error as any)?.response?.status === 404;
    if (is404) {
      navigate('/saml-apps', { replace: true });
      return null;
    }
    return (
      <Box sx={{ py: 4 }}>
        <Typography color="error">Failed to load application.</Typography>
        <Button onClick={() => navigate('/saml-apps')} sx={{ mt: 1 }}>
          Back to list
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <IconButton onClick={() => navigate('/saml-apps')} size="small">
            <ArrowBack />
          </IconButton>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Typography variant="h5" fontWeight={700}>{app.displayName}</Typography>
            <StatusDot enabled={app.enabled} />
          </Box>
        </Box>
        <Button
          variant="contained"
          startIcon={<EditIcon />}
          onClick={() => navigate(`/saml-apps/${appId}/edit`)}
        >
          Edit
        </Button>
      </Box>

      {/* General */}
      <Paper elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2.5, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} mb={1.5}>General</Typography>
        <Field label="Display Name" value={app.displayName} />
        <Field label="Description" value={app.description || <Typography variant="body2" color="text.disabled" component="span">—</Typography>} />
        <Field label="App ID" value={app.appId} mono />
        <Field label="Status" value={<StatusDot enabled={app.enabled} />} />
        <Field label="Created" value={formatDate(app.createdAt)} />
        <Field label="Updated" value={formatDate(app.updatedAt)} />
      </Paper>

      {/* SAML Configuration */}
      <Paper elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2.5, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} mb={1.5}>SAML Configuration</Typography>
        <Field label="SP Entity ID" value={app.spEntityId} mono />
        <Field label="ACS URL" value={app.acsUrl} mono />
        <Field
          label="Relay State"
          value={app.relayState || <Typography variant="body2" color="text.disabled" component="span">—</Typography>}
          mono={!!app.relayState}
        />
      </Paper>

      {/* Name ID */}
      <Paper elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2.5, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} mb={1.5}>Name ID</Typography>
        {app.nameId ? (
          <>
            <Field
              label="Format"
              value={
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                  {NAMEID_FORMATS.find((f) => f.value === app.nameId!.format)?.label ?? app.nameId.format}
                </Typography>
              }
            />
            <Field
              label="Source"
              value={
                <Chip
                  label={app.nameId.source === 'claim' ? 'VID Claim' : 'Static'}
                  size="small"
                  variant="outlined"
                  color={app.nameId.source === 'claim' ? 'primary' : 'default'}
                />
              }
            />
            <Field
              label="Value"
              value={app.nameId.value || <Typography variant="body2" color="text.disabled" component="span">—</Typography>}
              mono={!!app.nameId.value}
            />
          </>
        ) : (
          <Typography variant="body2" color="text.secondary" fontStyle="italic">
            Default — emailAddress format, mail claim
          </Typography>
        )}
      </Paper>

      {/* Attribute Mapping */}
      <Paper elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2.5, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} mb={1.5}>Attribute Mapping</Typography>
        {!(app.attributes ?? []).length ? (
          <Typography variant="body2" color="text.secondary" fontStyle="italic">
            No custom attributes configured — assertion contains NameID only.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            {(app.attributes ?? []).map((attr, idx) => (
              <Box
                key={idx}
                sx={{
                  py: 1.5,
                  borderBottom: idx < (app.attributes ?? []).length - 1 ? '1px solid' : 'none',
                  borderColor: 'divider',
                }}
              >
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', mb: 0.5 }}
                >
                  {attr.name}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Chip
                    label={attr.source === 'claim' ? `claim: ${attr.value}` : 'static'}
                    size="small"
                    variant="outlined"
                    color={attr.source === 'claim' ? 'primary' : 'default'}
                  />
                  {attr.source === 'static' && (
                    <Typography
                      variant="caption"
                      sx={{ fontFamily: 'monospace', wordBreak: 'break-all', color: 'text.secondary' }}
                    >
                      {attr.value}
                    </Typography>
                  )}
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Paper>

      {/* AWS IAM — shown only for legacy apps that still carry the role ARN fields */}
      {app.roleArn && (
        <Paper
          elevation={0}
          sx={{
            border: '1px solid',
            borderColor: alpha(theme.palette.warning.main, 0.15),
            borderRadius: 2,
            p: 2.5,
            mb: 2,
          }}
        >
          <Typography variant="subtitle1" fontWeight={700} mb={1.5}>AWS IAM (legacy)</Typography>
          <Field label="IAM Role ARN" value={app.roleArn} mono />
          {app.providerArn && <Field label="SAML Provider ARN" value={app.providerArn} mono />}
          {app.sessionName && <Field label="Session Name" value={app.sessionName} mono />}
          {app.sessionDuration != null && (
            <Field label="Session Duration" value={formatSessionDuration(app.sessionDuration)} />
          )}
        </Paper>
      )}

      {/* Access Control */}
      <Paper elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2.5, mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} mb={1.5}>Access Control</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 2, py: 1.5 }}>
          <Typography variant="body2" color="text.secondary" fontWeight={500}>Allowed Groups</Typography>
          {app.allowedGroupIds && app.allowedGroupIds.length > 0 ? (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {app.allowedGroupIds.map((id) => {
                const group = groupById[id];
                return (
                  <Chip
                    key={id}
                    label={group?.displayName ?? id}
                    title={id}
                    size="small"
                    sx={{ fontFamily: group?.displayName ? 'inherit' : 'monospace', fontSize: 11 }}
                  />
                );
              })}
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary" fontStyle="italic">
              All users allowed
            </Typography>
          )}
        </Box>
      </Paper>
    </Box>
  );
}
