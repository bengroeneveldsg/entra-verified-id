import React, { useState } from 'react';
import { apiClient } from '../../api/client';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add,
  ContentCopy,
  CheckCircle,
  Download,
  Edit,
  ToggleOn,
  ToggleOff,
} from '@mui/icons-material';

function downloadMetadata() {
  // Fetch server-side proxy — same origin (avoids CSP) and keeps cookies
  // so only authenticated admins can download. Blob URL avoids Edge's
  // insecure-download block on plain HTTP links.
  fetch('/api/admin/saml-apps/idp-metadata', { credentials: 'include' })
    .then((r) => r.blob())
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vid-idp-metadata.xml';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
}
import { DataGrid, GridColDef, GridRenderCellParams } from '@mui/x-data-grid';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow, format, parseISO } from 'date-fns';
import { samlAppsApi, SamlApp } from '../../api/samlApps';
import { dataGridSx, monoSx, STATUS_DOT_COLORS } from '../../components/TableStyles';

// ── Shared sub-components ────────────────────────────────────────────────────

/** Inline dot+label status indicator — no MUI Chip dependency */
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

export function SamlAppList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [metadataUrl, setMetadataUrl] = useState<string | null>(null);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);

  const showMetadataUrl = () => {
    apiClient.get('/config').then((r: any) => {
      const items: {key: string; value: string}[] = r.data ?? [];
      const domain = items.find((i: any) => i.key === 'public_domain')?.value;
      const url = domain ? `https://${domain}/api/saml/metadata` : '/api/saml/metadata';
      setMetadataUrl(url);
      // Try clipboard (HTTPS only); fall back to showing a dialog
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        }).catch(() => setUrlDialogOpen(true));
      } else {
        setUrlDialogOpen(true);
      }
    }).catch(() => setUrlDialogOpen(true));
  };

  const { data: apps = [], isLoading } = useQuery({
    queryKey: ['saml-apps'],
    queryFn: samlAppsApi.list,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ appId, enabled }: { appId: string; enabled: boolean }) =>
      enabled
        ? samlAppsApi.update(appId, { enabled: false })
        : samlAppsApi.delete(appId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saml-apps'] }),
    onError: (err: any) =>
      setError(err?.response?.data?.detail ?? 'Operation failed'),
  });

  const columns: GridColDef<SamlApp>[] = [
    {
      field: 'displayName',
      headerName: 'Name',
      flex: 1,
      minWidth: 160,
      renderCell: ({ row }) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
          {/* Teal accent dot prefix */}
          <Box
            component="span"
            sx={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              backgroundColor: '#0D9488',
              flexShrink: 0,
              opacity: 0.8,
            }}
          />
          <Typography
            variant="body2"
            fontWeight={600}
            sx={{ fontSize: 13, lineHeight: 1.4 }}
          >
            {row.displayName}
          </Typography>
        </Box>
      ),
    },
    {
      field: 'spEntityId',
      headerName: 'SP Entity ID',
      flex: 1.2,
      minWidth: 200,
      renderCell: ({ value }) => (
        <Tooltip title={value as string} placement="top">
          <Typography
            variant="caption"
            sx={{
              ...monoSx,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
              maxWidth: '100%',
            }}
          >
            {value as string}
          </Typography>
        </Tooltip>
      ),
    },
    {
      field: 'acsUrl',
      headerName: 'ACS URL',
      flex: 1.2,
      minWidth: 200,
      renderCell: ({ value }) => (
        <Tooltip title={value as string} placement="top">
          <Typography
            variant="caption"
            sx={{
              ...monoSx,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
              maxWidth: '100%',
            }}
          >
            {value as string}
          </Typography>
        </Tooltip>
      ),
    },
    {
      field: 'enabled',
      headerName: 'Status',
      width: 110,
      renderCell: ({ value }) => <StatusDot enabled={value as boolean} />,
    },
    {
      field: 'createdAt',
      headerName: 'Created',
      width: 130,
      renderCell: ({ value }) => {
        try {
          const date = parseISO(value as string);
          return (
            <Tooltip title={format(date, 'dd MMM yyyy HH:mm:ss')} placement="top">
              <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 12 }}>
                {formatDistanceToNow(date, { addSuffix: true })}
              </Typography>
            </Tooltip>
          );
        } catch {
          return <Typography variant="caption">{value as string}</Typography>;
        }
      },
    },
    {
      field: 'actions',
      headerName: '',
      width: 88,
      sortable: false,
      renderCell: ({ row }: GridRenderCellParams<SamlApp>) => (
        <Box className="actions-cell">
          <Tooltip title="Edit" placement="top">
            <IconButton
              size="small"
              onClick={() => navigate(`/saml-apps/${row.appId}`)}
              sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
            >
              <Edit sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={row.enabled ? 'Disable app' : 'Enable app'} placement="top">
            <IconButton
              size="small"
              onClick={() => toggleMutation.mutate({ appId: row.appId, enabled: row.enabled })}
              sx={{
                color: row.enabled ? 'success.main' : 'text.disabled',
                '&:hover': { color: row.enabled ? 'error.main' : 'success.main' },
              }}
            >
              {row.enabled
                ? <ToggleOn sx={{ fontSize: 16 }} />
                : <ToggleOff sx={{ fontSize: 16 }} />}
            </IconButton>
          </Tooltip>
        </Box>
      ),
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>SAML Applications</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage service providers that authenticate via Verified ID.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Get the metadata URL to paste into AWS IAM when creating a SAML provider">
            <Button
              variant="outlined"
              startIcon={copied ? <CheckCircle color="success" /> : <ContentCopy />}
              onClick={showMetadataUrl}
              color={copied ? 'success' : 'inherit'}
            >
              {copied ? 'Copied!' : 'Metadata URL'}
            </Button>
          </Tooltip>
          <Tooltip title="Download the IdP metadata XML file">
            <Button
              variant="outlined"
              startIcon={<Download />}
              onClick={() => downloadMetadata()}
            >
              Download Metadata
            </Button>
          </Tooltip>
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={() => navigate('/saml-apps/new')}
          >
            Add App
          </Button>
        </Box>
      </Box>

      <Alert severity="info" sx={{ mb: 2 }}>
        Before adding a new app, create an <strong>AWS IAM SAML Identity Provider</strong> using
        the downloaded metadata XML. The provider ARN you receive is shared across all apps.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <DataGrid
        rows={apps}
        columns={columns}
        getRowId={(row) => row.appId}
        loading={isLoading}
        density="compact"
        pageSizeOptions={[25, 50, 100]}
        initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
        disableRowSelectionOnClick
        autoHeight
        slots={{
          noRowsOverlay: () => (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 1,
                py: 6,
                color: 'text.disabled',
              }}
            >
              <Typography variant="body2" fontWeight={500}>
                No SAML applications configured
              </Typography>
              <Typography variant="caption">
                Add an app to enable service-provider authentication.
              </Typography>
            </Box>
          ),
        }}
        sx={dataGridSx}
      />

      {/* Fallback dialog for HTTP (no clipboard API) */}
      <Dialog open={urlDialogOpen} onClose={() => setUrlDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Metadata URL</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={2}>
            Copy this URL and paste it into AWS IAM when creating a SAML Identity Provider.
            Choose the <strong>"Metadata URL"</strong> option instead of uploading a file.
          </Typography>
          <TextField
            value={metadataUrl ?? ''}
            fullWidth
            InputProps={{ readOnly: true, sx: { fontFamily: 'monospace', fontSize: 13 } }}
            onFocus={(e) => e.target.select()}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUrlDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
