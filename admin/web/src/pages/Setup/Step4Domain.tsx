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
import { ExpandMore, HelpOutline } from '@mui/icons-material';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { setupApi } from '../../api/setup';

const schema = z.object({
  public_domain: z.string().min(1, 'Required'),
  api_domain: z.string().min(1, 'Required'),
  frontend_base_url: z.string().url('Must be a valid URL'),
  client_name: z.string().min(1, 'Required').max(60, 'Max 60 characters'),
});

type FormData = z.infer<typeof schema>;

interface Props {
  onNext: () => void;
}

export function Step4Domain({ onNext }: Props) {
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema), mode: 'onTouched' });

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await setupApi.configureDomain(data);
      onNext();
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'Failed to save domain configuration');
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Box>
        <Typography variant="h6" fontWeight={600}>Domain Settings</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Configure the public-facing domains and the display name shown to users during authentication.
        </Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <TextField
        label="Public Domain"
        fullWidth
        placeholder="example.com"
        error={!!errors.public_domain}
        helperText={errors.public_domain?.message ?? 'Primary domain of your deployment (no protocol)'}
        {...register('public_domain')}
      />

      <TextField
        label="API Domain"
        fullWidth
        placeholder="api.example.com"
        error={!!errors.api_domain}
        helperText={errors.api_domain?.message ?? 'Domain for the backend API'}
        {...register('api_domain')}
      />

      <TextField
        label="Frontend Base URL"
        fullWidth
        placeholder="https://example.com"
        error={!!errors.frontend_base_url}
        helperText={errors.frontend_base_url?.message ?? 'Full URL including protocol of the public frontend'}
        {...register('frontend_base_url')}
      />

      <TextField
        label="Client / Organisation Name"
        fullWidth
        placeholder="Acme Corporation"
        error={!!errors.client_name}
        helperText={errors.client_name?.message ?? 'Shown in QR code screens and credential prompts'}
        {...register('client_name')}
      />

      <Accordion elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px !important' }}>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <HelpOutline fontSize="small" color="action" />
            <Typography variant="body2">Domain setup notes</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary">
            These values are baked into <code>config.json</code> on the S3 hosting bucket and read by the
            public frontend at runtime. Ensure your CloudFront distribution and Route 53 records are already
            pointing to the correct origins before completing setup.
          </Typography>
        </AccordionDetails>
      </Accordion>

      <Button type="submit" variant="contained" size="large" disabled={isSubmitting}>
        {isSubmitting ? <CircularProgress size={22} color="inherit" /> : 'Save & Continue'}
      </Button>
    </Box>
  );
}
