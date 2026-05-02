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
} from '@mui/material';
import { ExpandMore, HelpOutline, CheckCircle } from '@mui/icons-material';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { setupApi } from '../../api/setup';

const schema = z.object({
  authority: z.string().min(1, 'Required').refine(
    (v) => v.startsWith('did:') || v.startsWith('https://'),
    'Must start with did: or https://',
  ),
  manifest_url: z.string().url('Must be a valid URL'),
  accepted_issuer: z.string().min(1, 'Required'),
});

type FormData = z.infer<typeof schema>;

interface Props {
  onNext: () => void;
}

export function Step3Did({ onNext }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [validated, setValidated] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting, isValid },
  } = useForm<FormData>({ resolver: zodResolver(schema), mode: 'onTouched' });

  const handleValidate = async () => {
    setError(null);
    const data = getValues();
    try {
      await setupApi.configureDid(data);
      setValidated(true);
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'DID validation failed');
      setValidated(false);
    }
  };

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await setupApi.configureDid(data);
      onNext();
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'Failed to save DID configuration');
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Box>
        <Typography variant="h6" fontWeight={600}>DID Configuration</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Configure the Decentralised Identifier (DID) that your deployment uses to sign verifiable credentials.
        </Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}
      {validated && <Alert severity="success" icon={<CheckCircle />}>DID document validated!</Alert>}

      <TextField
        label="DID Authority"
        fullWidth
        placeholder="did:web:yourdomain.com"
        error={!!errors.authority}
        helperText={errors.authority?.message ?? 'The DID identifier for your issuer (e.g. did:web:yourdomain.com)'}
        {...register('authority')}
      />

      <TextField
        label="Credential Manifest URL"
        fullWidth
        placeholder="https://..."
        error={!!errors.manifest_url}
        helperText={errors.manifest_url?.message ?? 'URL of the Entra Verified ID credential manifest'}
        {...register('manifest_url')}
      />

      <TextField
        label="Accepted Issuer DID"
        fullWidth
        placeholder="did:web:..."
        error={!!errors.accepted_issuer}
        helperText={errors.accepted_issuer?.message ?? 'DID of the trusted credential issuer'}
        {...register('accepted_issuer')}
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
            <strong>DID Authority &amp; Manifest URL:</strong>
            <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              <li>Azure Portal → Verified ID → Overview</li>
              <li>Copy the <strong>Decentralized Identifier</strong> for the authority</li>
              <li>Go to Credentials → your credential type → copy the <strong>Manifest URL</strong></li>
            </ol>
            <br />
            <strong>Accepted Issuer:</strong> The DID of the organisation that issued the credentials you accept.
            For self-issued credentials this is the same as your authority DID.
          </Typography>
        </AccordionDetails>
      </Accordion>

      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button type="button" variant="outlined" onClick={handleValidate} disabled={isSubmitting || !isValid}>
          Validate DID
        </Button>
        <Button type="submit" variant="contained" size="large" disabled={isSubmitting} sx={{ flex: 1 }}>
          {isSubmitting ? <CircularProgress size={22} color="inherit" /> : 'Save & Continue'}
        </Button>
      </Box>
    </Box>
  );
}
