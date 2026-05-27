import React, { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Divider,
} from '@mui/material';
import { ExpandMore, HelpOutline, CheckCircle } from '@mui/icons-material';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { setupApi } from '../../api/setup';

const schema = z.object({
  tenant_id: z.string().uuid('Must be a valid UUID'),
  issuer_verifier_client_id: z.string().uuid('Must be a valid UUID'),
  issuer_verifier_client_secret: z.string().min(1, 'Required'),
});

type FormData = z.infer<typeof schema>;

interface Props {
  onNext: () => void;
}

export function Step2Tenant({ onNext }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting, isValid },
  } = useForm<FormData>({ resolver: zodResolver(schema), mode: 'onTouched' });

  const handleTest = async () => {
    setError(null);
    const data = getValues();
    try {
      await setupApi.configureTenant(data);
      setTested(true);
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'Connection test failed');
      setTested(false);
    }
  };

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await setupApi.configureTenant(data);
      onNext();
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'Failed to save tenant configuration');
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Box>
        <Typography variant="h6" fontWeight={600}>Entra Tenant Configuration</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Configure the Azure app registration used for credential issuance and verification.
        </Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}
      {tested && <Alert severity="success" icon={<CheckCircle />}>Connection successful!</Alert>}

      <TextField
        label="Tenant ID"
        fullWidth
        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        error={!!errors.tenant_id}
        helperText={errors.tenant_id?.message ?? 'Your Azure AD / Entra tenant directory ID'}
        {...register('tenant_id')}
      />

      <Divider>
        <Typography variant="caption" color="text.secondary">Issuer / Verifier App Registration</Typography>
      </Divider>

      <TextField
        label="Client ID"
        fullWidth
        error={!!errors.issuer_verifier_client_id}
        helperText={errors.issuer_verifier_client_id?.message}
        {...register('issuer_verifier_client_id')}
      />
      <TextField
        label="Client Secret"
        type="password"
        fullWidth
        error={!!errors.issuer_verifier_client_secret}
        helperText={errors.issuer_verifier_client_secret?.message}
        {...register('issuer_verifier_client_secret')}
        inputProps={{ autoComplete: 'new-password' }}
      />

      <Accordion elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px !important' }}>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <HelpOutline fontSize="small" color="action" />
            <Typography variant="body2">Where do I find these values?</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary" component="div">
            <strong>Tenant ID:</strong> <a href="https://entra.microsoft.com" target="_blank" rel="noreferrer">Entra portal</a> → Identity → Overview → Directory (tenant) ID
            <br /><br />
            <strong>App Registrations:</strong>
            <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              <li><a href="https://entra.microsoft.com" target="_blank" rel="noreferrer">Entra portal</a> → App registrations → your app</li>
              <li><strong>Client ID</strong>: Application (client) ID on the Overview page</li>
              <li><strong>Client Secret</strong>: Certificates &amp; secrets → Client secrets → New client secret</li>
            </ol>
          </Typography>
        </AccordionDetails>
      </Accordion>

      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button type="button" variant="outlined" onClick={handleTest} disabled={isSubmitting || !isValid}>
          Test Connection
        </Button>
        <Button type="submit" variant="contained" size="large" disabled={isSubmitting} sx={{ flex: 1 }}>
          {isSubmitting ? <CircularProgress size={22} color="inherit" /> : 'Save & Continue'}
        </Button>
      </Box>
    </Box>
  );
}
