import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Alert,
  CircularProgress,
  Table,
  TableBody,
  TableRow,
  TableCell,
  Paper,
  Chip,
} from '@mui/material';
import { CheckCircle, Warning } from '@mui/icons-material';
import { setupApi } from '../../api/setup';
import { configApi, ConfigItem } from '../../api/config';
import { keysApi, KeyInfo } from '../../api/keys';

interface Props {
  onComplete: () => void;
}

const DISPLAY_KEYS: Record<string, string> = {
  tenant_id: 'Tenant ID',
  issuer_verifier_client_id: 'Issuer/Verifier Client ID',
  eam_provider_client_id: 'EAM Provider Client ID',
  did_authority: 'DID Authority',
  manifest_url: 'Manifest URL',
  accepted_issuer: 'Accepted Issuer',
  public_domain: 'Public Domain',
  api_domain: 'API Domain',
  frontend_base_url: 'Frontend Base URL',
  client_name: 'Client Name',
};

export function Step6Review({ onComplete }: Props) {
  const [configItems, setConfigItems] = useState<ConfigItem[]>([]);
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // These endpoints require auth; they may 401 during the wizard (before login).
    // Silently skip — config is already saved, review still shows the activate button.
    Promise.allSettled([configApi.list(), keysApi.getInfo()])
      .then(([cfgResult, keysResult]) => {
        if (cfgResult.status === 'fulfilled') setConfigItems(cfgResult.value);
        if (keysResult.status === 'fulfilled') setKeyInfo(keysResult.value);
      })
      .finally(() => setLoading(false));
  }, []);

  const displayItems = configItems.filter((i) => Object.keys(DISPLAY_KEYS).includes(i.key));

  const handleComplete = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await setupApi.completeSetup();
      onComplete();
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'Failed to complete setup');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography variant="h6" fontWeight={600}>Review & Activate</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Review your configuration before activating the deployment. This action cannot be undone
          through the wizard; use System Config to change values afterwards.
        </Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      {/* Config summary */}
      <Paper elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
        <Box sx={{ px: 2, py: 1.5, backgroundColor: 'action.hover' }}>
          <Typography variant="subtitle2" fontWeight={600}>Configuration Summary</Typography>
        </Box>
        <Table size="small">
          <TableBody>
            {displayItems.map((item) => (
              <TableRow key={item.key}>
                <TableCell sx={{ color: 'text.secondary', width: '40%', fontWeight: 500 }}>
                  {DISPLAY_KEYS[item.key] ?? item.key}
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>
                  {item.key.includes('secret') || item.key.includes('password')
                    ? '••••••••'
                    : item.value || <Typography variant="caption" color="error">Not set</Typography>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      {/* Key info */}
      {keyInfo?.kid && (
        <Paper elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
          <Box sx={{ px: 2, py: 1.5, backgroundColor: 'action.hover' }}>
            <Typography variant="subtitle2" fontWeight={600}>Signing Key</Typography>
          </Box>
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', width: '40%', fontWeight: 500 }}>Key ID (kid)</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>{keyInfo.kid}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500 }}>JWKS URL</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>
                  <a href={keyInfo.jwks_url} target="_blank" rel="noopener noreferrer">{keyInfo.jwks_url}</a>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Paper>
      )}

      <Alert
        severity="warning"
        icon={<Warning />}
        sx={{ borderRadius: 2 }}
      >
        Clicking <strong>Activate Deployment</strong> sets <code>onboarding_complete=true</code> and
        locks the setup wizard. Ensure all values above are correct.
      </Alert>

      <Button
        variant="contained"
        size="large"
        color="success"
        onClick={handleComplete}
        disabled={submitting}
        startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : <CheckCircle />}
      >
        {submitting ? 'Activating…' : 'Activate Deployment'}
      </Button>
    </Box>
  );
}
