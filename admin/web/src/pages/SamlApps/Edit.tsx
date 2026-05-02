import React, { useEffect, useState } from 'react';
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
  Chip,
  Divider,
  IconButton,
  InputAdornment,
} from '@mui/material';
import {
  ExpandMore,
  ArrowBack,
  Warning,
  Add,
  Close,
} from '@mui/icons-material';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { samlAppsApi, CreateSamlAppRequest } from '../../api/samlApps';

const schema = z.object({
  spEntityId: z.string().min(1, 'Required'),
  acsUrl: z.string().url('Must be a valid URL'),
  relayState: z.string().optional(),
  roleArn: z.string().min(1, 'Required').regex(/^arn:aws:iam::\d+:role\//, 'Must be a valid IAM Role ARN'),
  providerArn: z.string().min(1, 'Required').regex(/^arn:aws:iam::\d+:saml-provider\//, 'Must be a valid SAML provider ARN'),
  sessionName: z.string().min(1, 'Required').max(64),
  sessionDuration: z.number().int().min(900).max(43200),
  displayName: z.string().min(1, 'Required').max(80),
  description: z.string().max(120).optional(),
  allowedGroupIds: z.array(z.string()).optional(),
});

type FormData = z.infer<typeof schema>;

export function SamlAppEdit() {
  const { appId } = useParams<{ appId: string }>();
  const isNew = !appId || appId === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [groupInput, setGroupInput] = useState('');
  // Auto-expand and unlock the IAM section for new apps — it contains required fields
  const [dangerConfirmed, setDangerConfirmed] = useState(isNew);
  const [error, setError] = useState<string | null>(null);

  const { data: existing, isLoading } = useQuery({
    queryKey: ['saml-app', appId],
    queryFn: () => samlAppsApi.get(appId!),
    enabled: !isNew,
  });

  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      sessionName: 'VerifiedIDSession',
      sessionDuration: 3600,
      allowedGroupIds: [],
    },
  });

  useEffect(() => {
    if (existing) {
      reset({
        spEntityId: existing.spEntityId,
        acsUrl: existing.acsUrl,
        relayState: existing.relayState,
        roleArn: existing.roleArn,
        providerArn: existing.providerArn,
        sessionName: existing.sessionName,
        sessionDuration: existing.sessionDuration,
        displayName: existing.displayName,
        description: existing.description ?? '',
        allowedGroupIds: existing.allowedGroupIds,
      });
    }
  }, [existing, reset]);

  const allowedGroupIds = watch('allowedGroupIds') ?? [];

  const saveMutation = useMutation({
    mutationFn: (data: FormData) => {
      if (isNew) {
        return samlAppsApi.create(data as CreateSamlAppRequest);
      }
      return samlAppsApi.update(appId!, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saml-apps'] });
      navigate('/saml-apps');
    },
    onError: (err: any) =>
      setError(err?.response?.data?.detail ?? 'Save failed'),
  });

  const onSubmit = (data: FormData) => {
    setError(null);
    saveMutation.mutate(data);
  };

  const addGroup = () => {
    const trimmed = groupInput.trim();
    if (trimmed && !allowedGroupIds.includes(trimmed)) {
      setValue('allowedGroupIds', [...allowedGroupIds, trimmed]);
      setGroupInput('');
    }
  };

  if (!isNew && isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <IconButton onClick={() => navigate('/saml-apps')} size="small">
          <ArrowBack />
        </IconButton>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            {isNew ? 'New SAML Application' : `Edit: ${existing?.displayName ?? appId}`}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {isNew ? 'Register a new service provider.' : 'Update app configuration.'}
          </Typography>
        </Box>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Box component="form" onSubmit={handleSubmit(onSubmit)} sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, width: '100%' }}>
        <TextField
          label="Display Name"
          fullWidth
          error={!!errors.displayName}
          helperText={errors.displayName?.message ?? 'Shown in the admin app list and landing page tile'}
          {...register('displayName')}
        />

        <TextField
          label="Description"
          fullWidth
          multiline
          rows={2}
          error={!!errors.description}
          helperText={errors.description?.message ?? 'Short description shown on the landing page tile (max 120 characters)'}
          inputProps={{ maxLength: 120 }}
          {...register('description')}
        />

        <TextField
          label="SP Entity ID"
          fullWidth
          disabled={!isNew}
          error={!!errors.spEntityId}
          helperText={errors.spEntityId?.message ?? 'Immutable after creation'}
          {...register('spEntityId')}
        />

        <TextField
          label="ACS URL"
          fullWidth
          placeholder="https://signin.aws.amazon.com/saml"
          error={!!errors.acsUrl}
          helperText={errors.acsUrl?.message}
          {...register('acsUrl')}
        />

        <TextField
          label="Relay State"
          fullWidth
          placeholder="https://console.aws.amazon.com/"
          helperText="Optional redirect URL post-authentication"
          {...register('relayState')}
        />

        <Divider />

        {/* Allowed Groups */}
        <Box>
          <Typography variant="subtitle2" fontWeight={600} gutterBottom>
            Allowed Group IDs
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" mb={1}>
            Only users with matching Entra group claims will be allowed. Leave empty to allow all.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <TextField
              size="small"
              placeholder="Group Object ID"
              value={groupInput}
              onChange={(e) => setGroupInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addGroup())}
              fullWidth
            />
            <Button variant="outlined" startIcon={<Add />} onClick={addGroup}>
              Add
            </Button>
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {allowedGroupIds.map((id) => (
              <Chip
                key={id}
                label={id}
                onDelete={() =>
                  setValue('allowedGroupIds', allowedGroupIds.filter((g) => g !== id))
                }
                size="small"
                sx={{ fontFamily: 'monospace' }}
              />
            ))}
          </Box>
        </Box>

        <Divider />

        {/* AWS IAM Configuration — expanded by default on new apps since fields are required */}
        <Accordion
          elevation={0}
          defaultExpanded={isNew}
          sx={{
            border: '1px solid',
            borderColor: 'error.light',
            borderRadius: '8px !important',
            '&:before': { display: 'none' },
          }}
        >
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Warning color="error" fontSize="small" />
              <Typography variant="body2" fontWeight={600} color="error.main">
                AWS IAM Configuration (Danger Zone)
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2" color="text.secondary" mb={2}>
              These values control which IAM role is assumed after successful verification. Incorrect
              values will prevent all logins through this app. Confirm before editing.
            </Typography>

            {!dangerConfirmed ? (
              <Button
                variant="outlined"
                color="error"
                size="small"
                onClick={() => setDangerConfirmed(true)}
              >
                I understand — unlock these fields
              </Button>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Alert severity="warning" icon={<Warning />}>
                  Changes here will affect all new sessions immediately.
                </Alert>
                <TextField
                  label="IAM Role ARN"
                  fullWidth
                  placeholder="arn:aws:iam::123456789012:role/MyRole"
                  error={!!errors.roleArn}
                  helperText={errors.roleArn?.message}
                  {...register('roleArn')}
                />
                <TextField
                  label="SAML Provider ARN"
                  fullWidth
                  placeholder="arn:aws:iam::123456789012:saml-provider/MyProvider"
                  error={!!errors.providerArn}
                  helperText={errors.providerArn?.message}
                  {...register('providerArn')}
                />
                <TextField
                  label="Session Name"
                  fullWidth
                  error={!!errors.sessionName}
                  helperText={errors.sessionName?.message}
                  {...register('sessionName')}
                />
                <Controller
                  name="sessionDuration"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      label="Session Duration (seconds)"
                      type="number"
                      fullWidth
                      inputProps={{ min: 900, max: 43200 }}
                      error={!!errors.sessionDuration}
                      helperText={errors.sessionDuration?.message ?? '900–43200 seconds (15 min – 12 hr)'}
                      {...field}
                      onChange={(e) => field.onChange(parseInt(e.target.value, 10))}
                    />
                  )}
                />
              </Box>
            )}
          </AccordionDetails>
        </Accordion>

        <Box sx={{ display: 'flex', gap: 2, pt: 1 }}>
          <Button variant="outlined" onClick={() => navigate('/saml-apps')}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={isSubmitting}
            sx={{ flex: 1 }}
          >
            {isSubmitting ? <CircularProgress size={22} color="inherit" /> : isNew ? 'Create App' : 'Save Changes'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
