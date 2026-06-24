import React, { useEffect, useState } from 'react';
import {
  Autocomplete,
  Box,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Chip,
  Divider,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  Paper,
  Select,
  InputLabel,
  FormControl,
  FormHelperText,
} from '@mui/material';
import { Add, ArrowBack, Delete as DeleteIcon, CloudQueue } from '@mui/icons-material';
import { useForm, Controller, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  samlAppsApi,
  CreateSamlAppRequest,
  UpdateSamlAppRequest,
  EntraGroup,
  VID_CLAIMS,
  NAMEID_FORMATS,
} from '../../api/samlApps';

const DEFAULT_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const DEFAULT_ATTR_FORMAT = 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri';

const attributeSchema = z.object({
  name: z.string().min(1, 'Attribute name is required'),
  nameFormat: z.string().min(1, 'Required'),
  source: z.enum(['claim', 'static']),
  value: z.string().min(1, 'Value is required'),
});

const schema = z.object({
  spEntityId: z.string().min(1, 'Required'),
  acsUrl: z.string().url('Must be a valid URL'),
  relayState: z.string().optional(),
  displayName: z.string().min(1, 'Required').max(80),
  description: z.string().max(120).optional(),
  allowedGroupIds: z.array(z.string()).optional(),
  attributes: z.array(attributeSchema).default([]),
  nameId: z
    .object({
      format: z.string().min(1),
      source: z.enum(['claim', 'static']),
      value: z.string(),
    })
    .default({ format: DEFAULT_NAMEID_FORMAT, source: 'claim', value: 'mail' }),
});

type FormData = z.infer<typeof schema>;

interface AwsPresetForm {
  roleArn: string;
  providerArn: string;
  sessionName: string;
  sessionDuration: string;
}

export function SamlAppEdit() {
  const { appId } = useParams<{ appId: string }>();
  const isNew = !appId || appId === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [groupSearch, setGroupSearch] = useState('');
  const [debouncedGroupSearch, setDebouncedGroupSearch] = useState('');
  const [groupObjects, setGroupObjects] = useState<EntraGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [awsPresetOpen, setAwsPresetOpen] = useState(false);
  const [awsPreset, setAwsPreset] = useState<AwsPresetForm>({
    roleArn: '',
    providerArn: '',
    sessionName: 'VerifiedIDSession',
    sessionDuration: '3600',
  });

  const { data: existing, isLoading } = useQuery({
    queryKey: ['saml-app', appId],
    queryFn: () => samlAppsApi.get(appId!),
    enabled: !isNew,
  });

  const { data: resolvedGroups } = useQuery({
    queryKey: ['resolve-groups', existing?.allowedGroupIds],
    queryFn: () => samlAppsApi.resolveGroups(existing!.allowedGroupIds),
    enabled: !isNew && !!existing?.allowedGroupIds?.length,
    staleTime: 5 * 60_000,
  });

  // Debounce group search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedGroupSearch(groupSearch), 300);
    return () => clearTimeout(t);
  }, [groupSearch]);

  const { data: groupOptions = [], isFetching: groupsFetching } = useQuery({
    queryKey: ['group-search', debouncedGroupSearch],
    queryFn: () => samlAppsApi.searchGroups(debouncedGroupSearch),
    enabled: debouncedGroupSearch.length >= 2,
    staleTime: 30_000,
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
      attributes: [],
      nameId: { format: DEFAULT_NAMEID_FORMAT, source: 'claim', value: 'mail' },
      allowedGroupIds: [],
    },
  });

  const { fields: attributeFields, append: appendAttr, remove: removeAttr } = useFieldArray({
    control,
    name: 'attributes',
  });

  useEffect(() => {
    if (existing) {
      reset({
        spEntityId: existing.spEntityId,
        acsUrl: existing.acsUrl,
        relayState: existing.relayState ?? '',
        displayName: existing.displayName,
        description: existing.description ?? '',
        allowedGroupIds: existing.allowedGroupIds ?? [],
        attributes: existing.attributes ?? [],
        nameId: existing.nameId ?? { format: DEFAULT_NAMEID_FORMAT, source: 'claim', value: 'mail' },
      });
      if (existing.allowedGroupIds?.length) {
        setGroupObjects(existing.allowedGroupIds.map((id) => ({ id, displayName: id, description: '' })));
      }
    }
  }, [existing, reset]);

  // Replace placeholder group labels with resolved display names
  useEffect(() => {
    if (resolvedGroups?.length) {
      const byId = Object.fromEntries(resolvedGroups.map((g) => [g.id, g]));
      setGroupObjects((prev) => prev.map((g) => byId[g.id] ?? g));
    }
  }, [resolvedGroups]);

  const saveMutation = useMutation({
    mutationFn: (data: FormData) => {
      const payload: CreateSamlAppRequest & UpdateSamlAppRequest = {
        spEntityId: data.spEntityId,
        acsUrl: data.acsUrl,
        relayState: data.relayState,
        displayName: data.displayName,
        description: data.description,
        allowedGroupIds: data.allowedGroupIds,
        attributes: data.attributes,
        nameId: data.nameId,
      };
      if (isNew) return samlAppsApi.create(payload as CreateSamlAppRequest);
      return samlAppsApi.update(appId!, payload as UpdateSamlAppRequest);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saml-apps'] });
      navigate(isNew ? '/saml-apps' : `/saml-apps/${appId}`);
    },
    onError: (err: any) => setError(err?.response?.data?.detail ?? 'Save failed'),
  });

  const onSubmit = (data: FormData) => {
    setError(null);
    saveMutation.mutate(data);
  };

  const applyAwsPreset = () => {
    const uri = DEFAULT_ATTR_FORMAT;
    appendAttr({
      name: 'https://aws.amazon.com/SAML/Attributes/RoleSessionName',
      nameFormat: uri,
      source: 'static',
      value: awsPreset.sessionName,
    });
    appendAttr({
      name: 'https://aws.amazon.com/SAML/Attributes/Role',
      nameFormat: uri,
      source: 'static',
      value: `${awsPreset.roleArn},${awsPreset.providerArn}`,
    });
    appendAttr({
      name: 'https://aws.amazon.com/SAML/Attributes/SessionDuration',
      nameFormat: uri,
      source: 'static',
      value: awsPreset.sessionDuration,
    });
    setAwsPresetOpen(false);
  };

  if (!isNew && isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const nameIdSource = watch('nameId.source');

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <IconButton onClick={() => navigate(isNew ? '/saml-apps' : `/saml-apps/${appId}`)} size="small">
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

      <Box
        component="form"
        onSubmit={handleSubmit(onSubmit)}
        sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, width: '100%' }}
      >
        {/* ── Basic info ─────────────────────────────────────────────────── */}
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

        {/* ── Allowed Groups ─────────────────────────────────────────────── */}
        <Autocomplete
          multiple
          options={groupOptions}
          value={groupObjects}
          getOptionLabel={(opt) => opt.displayName || opt.id}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          filterSelectedOptions
          loading={groupsFetching}
          onInputChange={(_, val, reason) => {
            if (reason === 'input') setGroupSearch(val);
          }}
          onChange={(_, newValues) => {
            setGroupObjects(newValues);
            setValue('allowedGroupIds', newValues.map((g) => g.id));
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Allowed Groups"
              placeholder={groupObjects.length === 0 ? 'Type a group name to search…' : ''}
              helperText="Only members of these Entra groups can log in. Leave empty to allow all verified users."
              InputProps={{
                ...params.InputProps,
                endAdornment: (
                  <>
                    {groupsFetching && <CircularProgress size={18} />}
                    {params.InputProps.endAdornment}
                  </>
                ),
              }}
            />
          )}
          renderTags={(tags, getTagProps) =>
            tags.map((option, idx) => (
              <Chip
                {...getTagProps({ index: idx })}
                key={option.id}
                label={option.displayName || option.id}
                title={option.id}
                size="small"
                sx={{
                  fontFamily:
                    option.displayName && option.displayName !== option.id ? 'inherit' : 'monospace',
                }}
              />
            ))
          }
          renderOption={(props, option) => (
            <li {...props} key={option.id}>
              <Box>
                <Typography variant="body2">{option.displayName}</Typography>
                {option.description && (
                  <Typography variant="caption" color="text.secondary">
                    {option.description}
                  </Typography>
                )}
              </Box>
            </li>
          )}
          noOptionsText={
            debouncedGroupSearch.length < 2
              ? 'Type at least 2 characters to search'
              : 'No groups found'
          }
        />

        <Divider />

        {/* ── Name ID ────────────────────────────────────────────────────── */}
        <Paper
          elevation={0}
          sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2.5 }}
        >
          <Typography variant="subtitle2" fontWeight={600} mb={0.5}>
            Name ID
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={2}>
            Identifies the user to the service provider. Use <strong>persistent</strong> format
            for WorkSpaces Personal — the value must match the registered WorkSpaces username.
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Controller
              name="nameId.format"
              control={control}
              render={({ field }) => (
                <FormControl fullWidth>
                  <InputLabel>Format</InputLabel>
                  <Select label="Format" {...field}>
                    {NAMEID_FORMATS.map((f) => (
                      <MenuItem key={f.value} value={f.value}>
                        {f.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
            />
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Controller
                name="nameId.source"
                control={control}
                render={({ field }) => (
                  <FormControl sx={{ width: 160 }}>
                    <InputLabel>Source</InputLabel>
                    <Select label="Source" {...field}>
                      <MenuItem value="claim">VID Claim</MenuItem>
                      <MenuItem value="static">Static value</MenuItem>
                    </Select>
                  </FormControl>
                )}
              />
              {nameIdSource === 'claim' ? (
                <Controller
                  name="nameId.value"
                  control={control}
                  render={({ field }) => (
                    <FormControl sx={{ flex: 1 }}>
                      <InputLabel>Claim</InputLabel>
                      <Select label="Claim" {...field}>
                        {VID_CLAIMS.map((c) => (
                          <MenuItem key={c.value} value={c.value}>
                            {c.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  )}
                />
              ) : (
                <TextField
                  label="Static value"
                  sx={{ flex: 1 }}
                  helperText="Sent verbatim as the NameID value for every login"
                  {...register('nameId.value')}
                />
              )}
            </Box>
          </Box>
        </Paper>

        {/* ── Attribute Mapping ──────────────────────────────────────────── */}
        <Paper
          elevation={0}
          sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2.5 }}
        >
          <Box
            sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1.5 }}
          >
            <Box>
              <Typography variant="subtitle2" fontWeight={600}>
                Attribute Mapping
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Custom SAML attributes included in the assertion. Order is preserved. Blank by default.
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, ml: 2, flexShrink: 0 }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<CloudQueue />}
                onClick={() => setAwsPresetOpen(true)}
              >
                AWS Preset
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<Add />}
                onClick={() =>
                  appendAttr({ name: '', nameFormat: DEFAULT_ATTR_FORMAT, source: 'static', value: '' })
                }
              >
                Add
              </Button>
            </Box>
          </Box>

          {attributeFields.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontStyle: 'italic', py: 0.5 }}
            >
              No attributes configured — the assertion will contain only the NameID. Add attributes
              manually or use the AWS Preset for AWS console / WorkSpaces federation.
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {attributeFields.map((field, idx) => {
                const attrSource = watch(`attributes.${idx}.source`);
                return (
                  <Box
                    key={field.id}
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1,
                      p: 1.5,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                    }}
                  >
                    {/* Row 1: name, source, value, delete */}
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                      <TextField
                        label="Attribute Name (URI)"
                        size="small"
                        sx={{ flex: 2 }}
                        error={!!errors.attributes?.[idx]?.name}
                        helperText={errors.attributes?.[idx]?.name?.message}
                        {...register(`attributes.${idx}.name`)}
                      />
                      <Controller
                        name={`attributes.${idx}.source`}
                        control={control}
                        render={({ field: f }) => (
                          <FormControl size="small" sx={{ width: 130 }}>
                            <InputLabel>Source</InputLabel>
                            <Select label="Source" {...f}>
                              <MenuItem value="static">Static</MenuItem>
                              <MenuItem value="claim">VID Claim</MenuItem>
                            </Select>
                          </FormControl>
                        )}
                      />
                      {attrSource === 'claim' ? (
                        <Controller
                          name={`attributes.${idx}.value`}
                          control={control}
                          render={({ field: f }) => (
                            <FormControl size="small" sx={{ flex: 1 }}>
                              <InputLabel>Claim</InputLabel>
                              <Select label="Claim" {...f}>
                                {VID_CLAIMS.map((c) => (
                                  <MenuItem key={c.value} value={c.value}>
                                    {c.label}
                                  </MenuItem>
                                ))}
                              </Select>
                              {errors.attributes?.[idx]?.value && (
                                <FormHelperText error>
                                  {errors.attributes?.[idx]?.value?.message}
                                </FormHelperText>
                              )}
                            </FormControl>
                          )}
                        />
                      ) : (
                        <TextField
                          label="Value"
                          size="small"
                          sx={{ flex: 1 }}
                          error={!!errors.attributes?.[idx]?.value}
                          helperText={errors.attributes?.[idx]?.value?.message}
                          {...register(`attributes.${idx}.value`)}
                        />
                      )}
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => removeAttr(idx)}
                        sx={{ mt: 0.5 }}
                        title="Remove attribute"
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                    {/* Row 2: NameFormat (advanced) */}
                    <TextField
                      label="NameFormat"
                      size="small"
                      fullWidth
                      inputProps={{ style: { fontSize: 12, fontFamily: 'monospace' } }}
                      sx={{ '& .MuiInputLabel-root': { fontSize: 12 } }}
                      {...register(`attributes.${idx}.nameFormat`)}
                    />
                  </Box>
                );
              })}
            </Box>
          )}
        </Paper>

        {/* ── Actions ────────────────────────────────────────────────────── */}
        <Box sx={{ display: 'flex', gap: 2, pt: 1 }}>
          <Button
            variant="outlined"
            onClick={() => navigate(isNew ? '/saml-apps' : `/saml-apps/${appId}`)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={isSubmitting}
            sx={{ flex: 1 }}
          >
            {isSubmitting ? (
              <CircularProgress size={22} color="inherit" />
            ) : isNew ? (
              'Create App'
            ) : (
              'Save Changes'
            )}
          </Button>
        </Box>
      </Box>

      {/* ── AWS Federation Preset Dialog ───────────────────────────────────── */}
      <Dialog open={awsPresetOpen} onClose={() => setAwsPresetOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>AWS Federation Preset</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={2} mt={0.5}>
            Appends the three standard AWS SAML attributes (RoleSessionName, Role,
            SessionDuration) to the attribute list. Each entry is editable or removable
            after the preset is applied.
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="IAM Role ARN"
              fullWidth
              placeholder="arn:aws:iam::123456789012:role/MyRole"
              value={awsPreset.roleArn}
              onChange={(e) => setAwsPreset((p) => ({ ...p, roleArn: e.target.value }))}
            />
            <TextField
              label="SAML Provider ARN"
              fullWidth
              placeholder="arn:aws:iam::123456789012:saml-provider/MyProvider"
              value={awsPreset.providerArn}
              onChange={(e) => setAwsPreset((p) => ({ ...p, providerArn: e.target.value }))}
            />
            <TextField
              label="Session Name"
              fullWidth
              value={awsPreset.sessionName}
              onChange={(e) => setAwsPreset((p) => ({ ...p, sessionName: e.target.value }))}
            />
            <TextField
              label="Session Duration (seconds)"
              fullWidth
              type="number"
              inputProps={{ min: 900, max: 43200 }}
              value={awsPreset.sessionDuration}
              helperText="900–43200 seconds (15 min – 12 hr)"
              onChange={(e) => setAwsPreset((p) => ({ ...p, sessionDuration: e.target.value }))}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAwsPresetOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={applyAwsPreset}
            disabled={!awsPreset.roleArn.trim() || !awsPreset.providerArn.trim()}
          >
            Apply Preset
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
