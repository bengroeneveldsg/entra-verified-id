import React, { useState } from 'react';
import {
  Box,
  Typography,
  Alert,
  IconButton,
  Tooltip,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import { DeleteOutline, Refresh } from '@mui/icons-material';
import { DataGrid, GridColDef, GridRenderCellParams } from '@mui/x-data-grid';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, parseISO, differenceInMinutes } from 'date-fns';
import { sessionsApi, VidSession } from '../api/sessions';
import { dataGridSx, monoSx, STATUS_DOT_COLORS } from '../components/TableStyles';

// ── Status dot indicator ─────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  request_created: 'Created',
  verified: 'Verified',
  failed: 'Failed',
  revoked: 'Revoked',
};

function SessionStatusDot({ status }: { status: string }) {
  const cfg = STATUS_DOT_COLORS[status] ?? STATUS_DOT_COLORS['revoked'];
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
        backgroundColor: cfg.bg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: cfg.text,
        lineHeight: 1.6,
        textTransform: 'capitalize',
      }}
    >
      <Box
        component="span"
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: cfg.dot,
          flexShrink: 0,
        }}
      />
      {STATUS_LABELS[status] ?? status}
    </Box>
  );
}

// ── TTL / expires-in badge for pending sessions ──────────────────────────────
// Sessions created more than 15 min ago are considered stale if still pending.

function ExpiryBadge({ createdAt, status }: { createdAt: string; status: string }) {
  if (status !== 'pending' && status !== 'request_created') return null;
  try {
    const created = parseISO(createdAt);
    const minutesOld = differenceInMinutes(new Date(), created);
    // Assume a 15-minute TTL for pending sessions
    const ttlMinutes = 15;
    const remaining = ttlMinutes - minutesOld;
    if (remaining <= 0) {
      return (
        <Box
          component="span"
          sx={{
            ml: 1,
            px: '5px',
            py: '1px',
            borderRadius: '3px',
            backgroundColor: 'rgba(239,68,68,0.10)',
            color: '#7F1D1D',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.03em',
          }}
        >
          EXPIRED
        </Box>
      );
    }
    return (
      <Box
        component="span"
        sx={{
          ml: 1,
          px: '5px',
          py: '1px',
          borderRadius: '3px',
          backgroundColor: 'rgba(245,158,11,0.10)',
          color: '#92400E',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.03em',
          whiteSpace: 'nowrap',
        }}
      >
        {remaining}m left
      </Box>
    );
  } catch {
    return null;
  }
}

// ── Session type badge ───────────────────────────────────────────────────────

function TypeBadge({ type }: { type?: string }) {
  if (!type) return null;
  return (
    <Box
      component="span"
      sx={{
        px: '6px',
        py: '2px',
        borderRadius: '3px',
        backgroundColor: 'rgba(99,102,241,0.10)',
        color: '#312E81',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}
    >
      {type}
    </Box>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Sessions() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<VidSession | null>(null);

  const { data: sessions = [], isLoading, refetch } = useQuery({
    queryKey: ['sessions'],
    queryFn: sessionsApi.list,
    refetchInterval: 15_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (requestId: string) => sessionsApi.revoke(requestId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      setRevokeTarget(null);
    },
    onError: (err: any) =>
      setError(err?.response?.data?.detail ?? 'Revoke failed'),
  });

  const columns: GridColDef<VidSession>[] = [
    {
      field: 'requestId',
      headerName: 'Request ID',
      flex: 1,
      minWidth: 180,
      renderCell: ({ value }) => (
        <Tooltip title={value as string} placement="top">
          <Typography variant="caption" sx={monoSx}>
            {(value as string).slice(0, 8)}
            <Box component="span" sx={{ opacity: 0.45 }}>…</Box>
          </Typography>
        </Tooltip>
      ),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 140,
      renderCell: ({ value, row }) => (
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <SessionStatusDot status={value as string} />
          <ExpiryBadge createdAt={row.createdAt} status={value as string} />
        </Box>
      ),
    },
    {
      field: 'createdAt',
      headerName: 'Created',
      width: 150,
      renderCell: ({ value }) => {
        try {
          const date = parseISO(value as string);
          return (
            <Tooltip title={(value as string).replace('T', ' ').slice(0, 19)} placement="top">
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
      field: 'claims',
      headerName: 'Display Name',
      flex: 1,
      renderCell: ({ value, row }) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" sx={{ fontSize: 13 }}>
            {(value as VidSession['claims'])?.displayName ?? '—'}
          </Typography>
          {/* Show session type badge if available on the row */}
          <TypeBadge type={(row as any).sessionType ?? (row as any).type} />
        </Box>
      ),
    },
    {
      field: 'actions',
      headerName: '',
      width: 64,
      sortable: false,
      renderCell: ({ row }: GridRenderCellParams<VidSession>) => (
        <Box className="actions-cell">
          <Tooltip title="Revoke session" placement="top">
            <span>
              <IconButton
                size="small"
                disabled={row.status === 'revoked'}
                onClick={() => setRevokeTarget(row)}
                sx={{
                  color: 'error.main',
                  opacity: row.status === 'revoked' ? 0.3 : 1,
                  '&:hover': { backgroundColor: 'rgba(239,68,68,0.08)' },
                }}
              >
                <DeleteOutline sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      ),
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Active Sessions</Typography>
          <Typography variant="body2" color="text.secondary">
            Pending and in-progress Verified ID sessions. Auto-refreshes every 15 s.
          </Typography>
        </Box>
        <Button startIcon={<Refresh />} onClick={() => refetch()} variant="outlined">
          Refresh
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <DataGrid
        rows={sessions}
        columns={columns}
        getRowId={(row) => row.requestId}
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
                No active sessions
              </Typography>
              <Typography variant="caption">
                Sessions appear here when a Verified ID flow is initiated.
              </Typography>
            </Box>
          ),
        }}
        sx={dataGridSx}
      />

      {/* Revoke confirmation dialog */}
      <Dialog open={!!revokeTarget} onClose={() => setRevokeTarget(null)}>
        <DialogTitle>Revoke Session?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Revoking session{' '}
            <Box
              component="span"
              sx={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontWeight: 600 }}
            >
              {revokeTarget?.requestId?.slice(0, 8)}…
            </Box>{' '}
            will immediately prevent the user from completing authentication. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRevokeTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.requestId)}
            disabled={revokeMutation.isPending}
          >
            Revoke
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
