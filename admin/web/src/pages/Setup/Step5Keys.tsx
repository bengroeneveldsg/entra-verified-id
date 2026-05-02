import React, { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Alert,
  CircularProgress,
  ToggleButtonGroup,
  ToggleButton,
  TextField,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import { ExpandMore, HelpOutline, AutoFixHigh, VpnKey } from '@mui/icons-material';
import { setupApi } from '../../api/setup';

interface Props {
  onNext: () => void;
}

export function Step5Keys({ onNext }: Props) {
  const [mode, setMode] = useState<'generate' | 'existing'>('generate');
  const [existingPem, setExistingPem] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await setupApi.configureKeys({
        generate_new: mode === 'generate',
        existing_pem: mode === 'existing' ? existingPem : undefined,
      });
      onNext();
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'Failed to configure signing keys');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Box>
        <Typography variant="h6" fontWeight={600}>Signing Keys</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Configure the RSA-2048 key pair used to sign SAML assertions. The public key will be published
          to the JWKS endpoint on your hosting bucket.
        </Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <ToggleButtonGroup
        value={mode}
        exclusive
        onChange={(_, v) => v && setMode(v)}
        sx={{ width: '100%' }}
      >
        <ToggleButton value="generate" sx={{ flex: 1, py: 1.5, gap: 1 }}>
          <AutoFixHigh fontSize="small" />
          <Box textAlign="left">
            <Typography variant="body2" fontWeight={600}>Generate New Keys</Typography>
            <Typography variant="caption" color="text.secondary">Recommended for new deployments</Typography>
          </Box>
        </ToggleButton>
        <ToggleButton value="existing" sx={{ flex: 1, py: 1.5, gap: 1 }}>
          <VpnKey fontSize="small" />
          <Box textAlign="left">
            <Typography variant="body2" fontWeight={600}>Use Existing PEM</Typography>
            <Typography variant="caption" color="text.secondary">Key continuity from prior deployment</Typography>
          </Box>
        </ToggleButton>
      </ToggleButtonGroup>

      {mode === 'generate' && (
        <Alert severity="info">
          A new RSA-2048 key pair will be generated. The private key is stored in Secrets Manager
          and the public JWKS document is uploaded to your S3 hosting bucket.
        </Alert>
      )}

      {mode === 'existing' && (
        <TextField
          label="Private Key PEM"
          multiline
          rows={8}
          fullWidth
          value={existingPem}
          onChange={(e) => setExistingPem(e.target.value)}
          placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
          helperText="Paste the PKCS#8 PEM-encoded RSA-2048 private key"
          inputProps={{ style: { fontFamily: 'monospace', fontSize: 12 } }}
        />
      )}

      <Accordion elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px !important' }}>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <HelpOutline fontSize="small" color="action" />
            <Typography variant="body2">When should I use an existing key?</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary">
            Use an existing key only if you are migrating from a prior deployment and need AWS IAM
            identity providers (and therefore SAML metadata) to remain unchanged. In all other cases,
            generate a fresh key.
          </Typography>
        </AccordionDetails>
      </Accordion>

      <Button
        type="submit"
        variant="contained"
        size="large"
        disabled={loading || (mode === 'existing' && !existingPem.trim())}
      >
        {loading ? <CircularProgress size={22} color="inherit" /> : 'Bootstrap Keys & Continue'}
      </Button>
    </Box>
  );
}
