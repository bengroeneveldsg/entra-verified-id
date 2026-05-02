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
  InputAdornment,
  IconButton,
} from '@mui/material';
import { ExpandMore, Visibility, VisibilityOff, HelpOutline } from '@mui/icons-material';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { setupApi } from '../../api/setup';

const schema = z
  .object({
    bootstrapToken: z.string().min(1, 'Bootstrap token is required'),
    email: z.string().email('Valid email required'),
    password: z
      .string()
      .min(12, 'Minimum 12 characters')
      .regex(/[A-Z]/, 'Requires uppercase')
      .regex(/[a-z]/, 'Requires lowercase')
      .regex(/\d/, 'Requires digit')
      .regex(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, 'Requires special character'),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

type FormData = z.infer<typeof schema>;

interface Props {
  hasBootstrapSecret: boolean;
  onNext: () => void;
}

export function Step1AdminUser({ hasBootstrapSecret, onNext }: Props) {
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormData) => {
    setError(null);
    try {
      await setupApi.createAdminUser(
        { email: data.email, password: data.password },
        data.bootstrapToken,
      );
      onNext();
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'Failed to create admin user');
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Box>
        <Typography variant="h6" fontWeight={600}>Create Admin Account</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          This creates the first administrator account. After creation the bootstrap secret is deleted.
        </Typography>
      </Box>

      {!hasBootstrapSecret && (
        <Alert severity="warning">
          No bootstrap secret was found in Secrets Manager. Check that the deployment created the
          <code> EntraVerifiedID/{'{stage}'}/bootstrap-admin</code> secret.
        </Alert>
      )}

      {error && <Alert severity="error">{error}</Alert>}

      <TextField
        label="Bootstrap Token"
        type="password"
        fullWidth
        helperText="The password value from the bootstrap-admin Secrets Manager secret"
        error={!!errors.bootstrapToken}
        {...register('bootstrapToken')}
        inputProps={{ autoComplete: 'off' }}
      />

      <TextField
        label="Admin Email"
        type="email"
        fullWidth
        autoComplete="username"
        error={!!errors.email}
        helperText={errors.email?.message}
        {...register('email')}
      />

      <TextField
        label="Password"
        type={showPw ? 'text' : 'password'}
        fullWidth
        autoComplete="new-password"
        error={!!errors.password}
        helperText={errors.password?.message ?? 'Min 12 chars, uppercase, lowercase, digit, special character'}
        {...register('password')}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton onClick={() => setShowPw((v) => !v)} edge="end">
                {showPw ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          ),
        }}
      />

      <TextField
        label="Confirm Password"
        type="password"
        fullWidth
        autoComplete="new-password"
        error={!!errors.confirm}
        helperText={errors.confirm?.message}
        {...register('confirm')}
      />

      <Accordion elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px !important' }}>
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <HelpOutline fontSize="small" color="action" />
            <Typography variant="body2">Where do I find the bootstrap token?</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary" component="div">
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>Open the <strong>AWS Console</strong> → Secrets Manager</li>
              <li>Find the secret named <code>EntraVerifiedID/{'{stage}'}/bootstrap-admin</code></li>
              <li>Click <strong>Retrieve secret value</strong></li>
              <li>Copy the <code>password</code> field value</li>
            </ol>
          </Typography>
        </AccordionDetails>
      </Accordion>

      <Button type="submit" variant="contained" size="large" disabled={isSubmitting}>
        {isSubmitting ? <CircularProgress size={22} color="inherit" /> : 'Create Account & Continue'}
      </Button>
    </Box>
  );
}
