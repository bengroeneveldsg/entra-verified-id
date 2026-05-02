import React, { useState } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  Alert,
  CircularProgress,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Divider,
} from '@mui/material';
import {
  Autorenew,
  ContentCopy,
  CheckCircle,
  Warning,
  Download,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { keysApi } from '../api/keys';

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <TextField
      label={label}
      value={value}
      fullWidth
      InputProps={{
        readOnly: true,
        sx: { fontFamily: 'monospace', fontSize: 13 },
        endAdornment: (
          <Tooltip title={copied ? 'Copied!' : 'Copy'}>
            <IconButton onClick={copy} edge="end" size="small">
              {copied ? <CheckCircle color="success" fontSize="small" /> : <ContentCopy fontSize="small" />}
            </IconButton>
          </Tooltip>
        ),
      }}
    />
  );
}

function downloadMetadata(metadataUrl: string) {
  fetch(metadataUrl)
    .then((r) => r.text())
    .then((xml) => {
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vid-idp-metadata.xml';
      a.click();
      URL.revokeObjectURL(url);
    });
}

export default function Keys() {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: keyInfo, isLoading } = useQuery({
    queryKey: ['key-info'],
    queryFn: keysApi.getInfo,
  });

  const rotateMutation = useMutation({
    mutationFn: keysApi.rotate,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['key-info'] });
      setConfirmOpen(false);
      setSuccess(`Key rotated successfully. New kid: ${data.kid}`);
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? 'Rotation failed');
      setConfirmOpen(false);
    },
  });

  const formattedDate = keyInfo?.created_at
    ? (() => {
        try {
          return format(parseISO(keyInfo.created_at), "dd MMM yyyy 'at' HH:mm 'UTC'");
        } catch {
          return keyInfo.created_at;
        }
      })()
    : null;

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>Signing Keys</Typography>
        <Typography variant="body2" color="text.secondary">
          Manage the RSA-2048 key pair used to sign SAML assertions and JWTs.
        </Typography>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {success && <Alert severity="success" icon={<CheckCircle />} sx={{ mb: 2 }} onClose={() => setSuccess(null)}>{success}</Alert>}

      <Card elevation={0} sx={{ border: '1px solid', borderColor: 'divider' }}>
        <CardContent sx={{ p: 3 }}>
          {isLoading ? (
            <CircularProgress />
          ) : keyInfo?.kid ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Current Key
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Created / last rotated: <strong>{formattedDate ?? '—'}</strong>
                </Typography>
              </Box>

              <CopyField label="Key ID (kid)" value={keyInfo.kid} />
              <CopyField label="JWKS URL" value={keyInfo.jwks_url} />
              <CopyField label="OIDC Config URL" value={keyInfo.oidc_config_url} />

              <Divider />

              {/* IdP Metadata download */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>SAML IdP Metadata</Typography>
                <Typography variant="body2" color="text.secondary" mb={2}>
                  Download the federation metadata XML file and upload it to AWS IAM when creating
                  a new SAML identity provider. This is the equivalent of Entra's
                  "Download federation metadata XML" button.
                </Typography>
                <Button
                  variant="outlined"
                  startIcon={<Download />}
                  onClick={() => {
                    // Derive the metadata URL from the JWKS URL (same domain)
                    const base = keyInfo?.jwks_url
                      ? keyInfo.jwks_url.replace('/.well-known/jwks.json', '')
                      : window.location.origin;
                    downloadMetadata(`${base}/api/saml/metadata`);
                  }}
                >
                  Download IdP Metadata (XML)
                </Button>
              </Box>

              <Divider />

              <Box>
                <Typography variant="subtitle2" gutterBottom>Key Rotation</Typography>
                <Typography variant="body2" color="text.secondary" mb={2}>
                  Rotating generates a new RSA-2048 key. The old key is kept in the JWKS for a grace
                  period so existing tokens remain valid. AWS IAM identity providers must be updated
                  with the new SAML metadata after rotation.
                </Typography>
                <Button
                  variant="contained"
                  color="warning"
                  startIcon={<Autorenew />}
                  onClick={() => setConfirmOpen(true)}
                >
                  Rotate Keys
                </Button>
              </Box>
            </Box>
          ) : (
            <Alert severity="info">
              No signing key found. Complete the setup wizard to bootstrap keys.
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Confirmation dialog */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Warning color="warning" /> Rotate Signing Keys?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            This generates a new RSA-2048 key pair and uploads a new JWKS document to S3. You will
            need to re-upload SAML metadata to any AWS IAM identity providers. The old key is
            retained in the JWKS for a grace window.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => rotateMutation.mutate()}
            disabled={rotateMutation.isPending}
            startIcon={rotateMutation.isPending ? <CircularProgress size={18} color="inherit" /> : <Autorenew />}
          >
            {rotateMutation.isPending ? 'Rotating…' : 'Rotate Now'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
