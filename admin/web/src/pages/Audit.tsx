import React, { useState } from 'react';
import {
  Box,
  Typography,
  Alert,
  TextField,
  Button,
  Tab,
  Tabs,
  CircularProgress,
  Chip,
  Tooltip,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import { Search, Refresh } from '@mui/icons-material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { auditApi, AuditEntry } from '../api/audit';
import { dataGridSx, monoSx, STATUS_DOT_COLORS } from '../components/TableStyles';

// ── Action chip colours (unchanged business logic) ───────────────────────────

const ACTION_COLORS: Record<string, 'default' | 'info' | 'warning' | 'error' | 'success'> = {
  'auth.login': 'success',
  'auth.logout': 'default',
  'auth.login_failed': 'error',
  'auth.change_password': 'warning',
  'auth.mfa_enrolled': 'info',
  'setup.complete': 'success',
  'saml_app.create': 'info',
  'saml_app.update': 'warning',
  'saml_app.disable': 'error',
  'keys.rotate': 'warning',
  'session.revoke': 'error',
};

const LOG_GROUP_OPTIONS = [
  { label: 'Admin Console', value: '/entra-vid/admin-v2' },
  { label: 'Public Frontend', value: '/entra-vid/frontend-v2' },
];

// ── Tighter action chip ──────────────────────────────────────────────────────

function ActionChip({ action }: { action: string }) {
  const color = ACTION_COLORS[action] ?? 'default';
  return (
    <Chip
      label={action}
      color={color}
      size="small"
      sx={{
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 10,
        height: 20,
        letterSpacing: '0.02em',
        '& .MuiChip-label': { px: '6px', py: 0 },
        borderRadius: '4px',
      }}
    />
  );
}

// ── Log-level dot indicator ──────────────────────────────────────────────────

function LogLevelDot({ level }: { level: string }) {
  const cfg =
    STATUS_DOT_COLORS[level as keyof typeof STATUS_DOT_COLORS] ??
    STATUS_DOT_COLORS['INFO'];
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        px: '6px',
        py: '1px',
        borderRadius: '3px',
        backgroundColor: cfg.bg,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        color: cfg.text,
        lineHeight: 1.6,
        textTransform: 'uppercase',
      }}
    >
      <Box
        component="span"
        sx={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          backgroundColor: cfg.dot,
          flexShrink: 0,
        }}
      />
      {level}
    </Box>
  );
}

// ── Runtime Logs sub-page ────────────────────────────────────────────────────

function RuntimeLogs() {
  const [minutes, setMinutes] = useState(60);
  const [logGroup, setLogGroup] = useState('/entra-vid/admin-v2');
  const { data, isLoading, refetch, error } = useQuery({
    queryKey: ['runtime-logs', minutes, logGroup],
    queryFn: () => auditApi.getRuntimeLogs(minutes, logGroup),
    enabled: false,
  });

  return (
    <Box sx={{ pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="log-group-label">Log Group</InputLabel>
          <Select
            labelId="log-group-label"
            label="Log Group"
            value={logGroup}
            onChange={(e) => setLogGroup(e.target.value)}
          >
            {LOG_GROUP_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          label="Time window (minutes)"
          type="number"
          size="small"
          value={minutes}
          onChange={(e) => setMinutes(Math.max(1, parseInt(e.target.value, 10)))}
          sx={{ width: 200 }}
          inputProps={{ min: 1, max: 1440 }}
        />
        <Button
          variant="contained"
          startIcon={isLoading ? <CircularProgress size={18} color="inherit" /> : <Search />}
          onClick={() => refetch()}
          disabled={isLoading}
        >
          Fetch Logs
        </Button>
      </Box>

      {error && (
        <Alert severity="error">{(error as any)?.response?.data?.detail ?? 'Failed to fetch logs'}</Alert>
      )}

      {data && (
        <>
          <Typography variant="caption" color="text.secondary">
            {data.rows.length} event{data.rows.length !== 1 ? 's' : ''} (health checks excluded)
            {data.statistics?.bytesScanned
              ? ` · ${(data.statistics.bytesScanned / 1024).toFixed(1)} KB scanned`
              : ''}
          </Typography>
          {data.rows.length === 0 ? (
            <Alert severity="info">No events found in the selected window (health checks are filtered).</Alert>
          ) : (
            <DataGrid
              rows={data.rows.map((r: any, i: number) => ({ id: i, ...r }))}
              columns={[
                {
                  field: 'timestamp',
                  headerName: 'Time',
                  width: 165,
                  renderCell: ({ value }) => (
                    <Typography
                      variant="caption"
                      sx={{
                        ...monoSx,
                        color: 'text.secondary',
                      }}
                    >
                      {String(value ?? '').replace('T', ' ').slice(0, 19)}
                    </Typography>
                  ),
                },
                {
                  field: 'level',
                  headerName: 'Level',
                  width: 82,
                  renderCell: ({ value }) => (
                    <LogLevelDot level={value as string} />
                  ),
                },
                {
                  field: 'message',
                  headerName: 'Message',
                  flex: 1,
                  renderCell: ({ row }) => {
                    const text =
                      row.type === 'request'
                        ? `${row.method} ${row.path} → ${row.status} (${row.client})`
                        : String(row.message ?? '');
                    const typePrefix = row.type ? row.type : null;
                    return (
                      <Tooltip title={JSON.stringify(row.details ?? {}, null, 2)} placement="top">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', width: '100%' }}>
                          {typePrefix && (
                            <Box
                              component="span"
                              sx={{
                                flexShrink: 0,
                                px: '5px',
                                py: '1px',
                                borderRadius: '3px',
                                backgroundColor: 'rgba(99,102,241,0.08)',
                                color: '#4338CA',
                                fontSize: 9,
                                fontWeight: 700,
                                letterSpacing: '0.07em',
                                textTransform: 'uppercase',
                              }}
                            >
                              {typePrefix}
                            </Box>
                          )}
                          <Typography
                            variant="caption"
                            sx={{
                              ...monoSx,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              display: 'block',
                            }}
                          >
                            {text}
                          </Typography>
                        </Box>
                      </Tooltip>
                    );
                  },
                },
              ]}
              density="compact"
              disableRowSelectionOnClick
              pageSizeOptions={[25, 50, 100]}
              initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
              slots={{
                noRowsOverlay: () => (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                      py: 4,
                      color: 'text.disabled',
                    }}
                  >
                    <Typography variant="body2" fontWeight={500}>
                      No log events
                    </Typography>
                  </Box>
                ),
              }}
              sx={dataGridSx}
            />
          )}
        </>
      )}
    </Box>
  );
}

// ── Audit Events (main tab) ──────────────────────────────────────────────────

export default function Audit() {
  const [tab, setTab] = useState(0);
  const [actor, setActor] = useState('');
  const [fromTs, setFromTs] = useState('');
  const [toTs, setToTs] = useState('');
  const [filters, setFilters] = useState<{ actor?: string; from_ts?: string; to_ts?: string }>({});

  const { data: entries = [], isLoading, refetch } = useQuery({
    queryKey: ['audit-log', filters],
    queryFn: () => auditApi.list(filters),
  });

  const columns: GridColDef<AuditEntry>[] = [
    {
      field: 'timestamp',
      headerName: 'Time',
      width: 155,
      renderCell: ({ value }) => {
        try {
          return (
            <Typography
              variant="caption"
              sx={{
                ...monoSx,
                color: 'text.secondary',
              }}
            >
              {format(parseISO(value as string), 'dd MMM HH:mm:ss')}
            </Typography>
          );
        } catch {
          return <Typography variant="caption" sx={monoSx}>{value as string}</Typography>;
        }
      },
    },
    {
      field: 'actor',
      headerName: 'Actor',
      width: 180,
      renderCell: ({ value }) => (
        <Typography variant="caption" sx={{ ...monoSx, fontWeight: 500 }}>
          {value as string}
        </Typography>
      ),
    },
    {
      field: 'action',
      headerName: 'Action',
      width: 190,
      renderCell: ({ value }) => <ActionChip action={value as string} />,
    },
    {
      field: 'target',
      headerName: 'Target',
      flex: 0.8,
      renderCell: ({ value }) => {
        const str = (value as string) ?? '';
        const truncated = str.length > 40 ? `${str.slice(0, 40)}…` : str;
        return (
          <Tooltip title={str} placement="top">
            <Typography variant="caption" sx={{ ...monoSx, color: 'text.secondary' }}>
              {truncated}
            </Typography>
          </Tooltip>
        );
      },
    },
    {
      field: 'sourceIp',
      headerName: 'Source IP',
      width: 130,
      renderCell: ({ value }) => (
        <Typography variant="caption" sx={{ ...monoSx, color: 'text.secondary' }}>
          {(value as string) ?? '—'}
        </Typography>
      ),
    },
    {
      field: 'details',
      headerName: 'Details',
      flex: 1,
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
              color: 'text.secondary',
            }}
          >
            {value as string}
          </Typography>
        </Tooltip>
      ),
    },
  ];

  const applyFilters = () => {
    setFilters({
      actor: actor || undefined,
      from_ts: fromTs || undefined,
      to_ts: toTs || undefined,
    });
  };

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>Audit Log</Typography>
        <Typography variant="body2" color="text.secondary">
          All administrative actions and authentication events.
        </Typography>
      </Box>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Audit Events" />
        <Tab label="Runtime Logs (CloudWatch)" />
      </Tabs>

      {tab === 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Filter bar */}
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <TextField
              label="Actor"
              size="small"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              sx={{ minWidth: 200 }}
            />
            <TextField
              label="From"
              type="datetime-local"
              size="small"
              value={fromTs}
              onChange={(e) => setFromTs(e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ minWidth: 200 }}
            />
            <TextField
              label="To"
              type="datetime-local"
              size="small"
              value={toTs}
              onChange={(e) => setToTs(e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ minWidth: 200 }}
            />
            <Button
              variant="contained"
              startIcon={<Search />}
              onClick={applyFilters}
            >
              Filter
            </Button>
            <Button
              variant="outlined"
              startIcon={<Refresh />}
              onClick={() => refetch()}
            >
              Refresh
            </Button>
          </Box>

          <DataGrid
            rows={entries}
            columns={columns}
            getRowId={(row) => row.sk}
            loading={isLoading}
            density="compact"
            pageSizeOptions={[50, 100, 200]}
            initialState={{ pagination: { paginationModel: { pageSize: 50 } } }}
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
                    No audit events found
                  </Typography>
                  <Typography variant="caption">
                    Try adjusting the filters or expanding the time range.
                  </Typography>
                </Box>
              ),
            }}
            sx={dataGridSx}
          />
        </Box>
      )}

      {tab === 1 && <RuntimeLogs />}
    </Box>
  );
}
