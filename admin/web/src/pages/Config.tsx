import React, { useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Business,
  Check,
  CheckCircle,
  Close,
  Edit,
  ExpandMore,
  Fingerprint,
  Key,
  Language,
  Lock,
  RadioButtonUnchecked,
  Security,
  VerifiedUser,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { configApi, ConfigItem } from '../api/config';

// ── Key → friendly label + description mapping ────────────────────────────────

const KEY_META: Record<string, { label: string; description: string }> = {
  tenant_id:                  { label: 'Tenant ID',                  description: 'Azure AD / Entra tenant directory ID' },
  issuer_verifier_client_id:  { label: 'IssuerVerifier Client ID',   description: 'App registration for credential issuance and verification' },
  eam_provider_client_id:     { label: 'EAM Provider Client ID',     description: 'App registration for External Authentication Method' },
  did_authority:              { label: 'DID Authority',              description: 'Your Decentralised Identifier (DID)' },
  authority:                  { label: 'Authority (runtime)',        description: 'DID authority used by Lambda handlers' },
  manifest_url:               { label: 'Credential Manifest URL',   description: 'Entra Verified ID credential contract manifest' },
  accepted_issuer:            { label: 'Accepted Issuer DID',       description: 'Trusted issuer for credential verification' },
  public_domain:              { label: 'Public Domain',             description: 'User-facing domain for the deployment' },
  api_domain:                 { label: 'API Domain',                description: 'API Gateway domain for backend callbacks' },
  frontend_base_url:          { label: 'Frontend Base URL',         description: 'Full URL of the public frontend' },
  callback_base_url:          { label: 'Callback Base URL',         description: 'Base URL for Entra VID webhook callbacks' },
  issuer:                     { label: 'OIDC Issuer',               description: 'Issuer claim in id_tokens (should match frontend URL)' },
  client_name:                { label: 'Organisation Name',         description: 'Display name shown to users in QR screens' },
  entity_id:                  { label: 'SAML Entity ID',            description: 'IdP entity ID in SAML metadata and assertions' },
  saml_sso_url:               { label: 'SAML SSO URL',              description: 'Single Sign-On service URL for SAML requests' },
  saml_jwks_url:              { label: 'SAML JWKS URL',             description: 'JWKS endpoint used in SAML metadata' },
  kid:                        { label: 'Signing Key ID',            description: 'Active signing key identifier' },
  key_created_at:             { label: 'Key Created',               description: 'When the signing key was bootstrapped' },
  key_rotated_at:             { label: 'Key Last Rotated',          description: 'When the signing key was last rotated' },
};

// ── Section definitions ───────────────────────────────────────────────────────

const SECTIONS = [
  {
    id: 'tenant',
    label: 'Entra Tenant',
    icon: <Business />,
    keys: ['tenant_id', 'issuer_verifier_client_id', 'eam_provider_client_id'],
    description: 'Azure AD app registrations used for credential operations',
  },
  {
    id: 'identity',
    label: 'Identity & Credentials',
    icon: <Fingerprint />,
    keys: ['did_authority', 'authority', 'manifest_url', 'accepted_issuer'],
    description: 'Decentralised Identifier and credential contract configuration',
  },
  {
    id: 'domain',
    label: 'Domain & Endpoints',
    icon: <Language />,
    keys: ['public_domain', 'api_domain', 'frontend_base_url', 'callback_base_url', 'issuer', 'client_name'],
    description: 'URLs, domains, and display settings',
  },
  {
    id: 'saml',
    label: 'SAML Identity Provider',
    icon: <VerifiedUser />,
    keys: ['entity_id', 'saml_sso_url', 'saml_jwks_url'],
    description: 'SAML IdP endpoints and identifiers',
  },
  {
    id: 'keys',
    label: 'Signing Keys',
    icon: <Key />,
    keys: ['kid', 'key_created_at', 'key_rotated_at'],
    description: 'RSA-2048 signing key metadata — manage via Signing Keys page',
  },
];

const SETUP_KEYS = [
  { key: 'setup_admin_complete',  label: 'Admin account created' },
  { key: 'setup_tenant_complete', label: 'Entra tenant configured' },
  { key: 'setup_did_complete',    label: 'DID configured' },
  { key: 'setup_domain_complete', label: 'Domain configured' },
  { key: 'setup_keys_complete',   label: 'Signing keys bootstrapped' },
  { key: 'onboarding_complete',   label: 'Onboarding complete' },
];

// ── Inline edit row ───────────────────────────────────────────────────────────

function ConfigField({
  item,
  onSave,
  saving,
}: {
  item: ConfigItem;
  onSave: (key: string, value: string) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(item.value);
  const meta = KEY_META[item.key] ?? { label: item.key, description: '' };

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 2, py: 2, borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 'none' }, alignItems: 'start' }}>
      {/* Label column — fixed 240px so all sections align identically */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography variant="body2" fontWeight={600} sx={{ fontSize: 13 }}>
            {meta.label}
          </Typography>
          {item.read_only && (
            <Tooltip title="Managed by the system">
              <Lock sx={{ fontSize: 13, color: 'text.disabled', ml: 0.5 }} />
            </Tooltip>
          )}
        </Box>
        {meta.description && (
          <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
            {meta.description}
          </Typography>
        )}
        <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: 10, color: 'text.disabled', display: 'block', mt: 0.5 }}>
          {item.key}
        </Typography>
      </Box>

      {/* Value column */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <TextField
              size="small"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              fullWidth
              multiline={draft.length > 60}
              maxRows={4}
              inputProps={{ style: { fontFamily: 'monospace', fontSize: 12 } }}
              autoFocus
            />
            <IconButton size="small" color="success" onClick={() => { onSave(item.key, draft); setEditing(false); }} disabled={saving}>
              {saving ? <CircularProgress size={14} /> : <Check fontSize="small" />}
            </IconButton>
            <IconButton size="small" onClick={() => { setEditing(false); setDraft(item.value); }}>
              <Close fontSize="small" />
            </IconButton>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
            <Typography
              variant="body2"
              sx={{
                fontFamily: 'monospace',
                fontSize: 12,
                flex: 1,
                wordBreak: 'break-all',
                color: item.value ? 'text.primary' : 'text.disabled',
                lineHeight: 1.6,
              }}
            >
              {item.value || <em>not set</em>}
            </Typography>
            {!item.read_only && (
              <Tooltip title="Edit">
                <IconButton size="small" onClick={() => setEditing(true)} sx={{ flexShrink: 0, mt: -0.25 }}>
                  <Edit sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        )}
        {item.updated_by && (
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10, display: 'block', mt: 0.5 }}>
            {item.updated_by} · {(() => { try { return format(parseISO(item.updated_at), 'dd MMM yy HH:mm'); } catch { return item.updated_at; } })()}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Config() {
  const qc = useQueryClient();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [expanded, setExpanded]   = useState<string | false>('tenant');

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: configApi.list,
  });

  const updateMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => configApi.update(key, value),
    onMutate:   ({ key }) => setSavingKey(key),
    onSettled:  () => setSavingKey(null),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['config'] }),
    onError:    (err: any) => setError(err?.response?.data?.detail ?? 'Update failed'),
  });

  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  const setupItems = SETUP_KEYS.map((s) => ({ ...s, done: byKey[s.key]?.value === 'true' }));
  const allDone = setupItems.every((s) => s.done);

  const handleChange = (panel: string) => (_: React.SyntheticEvent, isExpanded: boolean) => {
    setExpanded(isExpanded ? panel : false);
  };

  if (isLoading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', pt: 8 }}><CircularProgress /></Box>;
  }

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>System Configuration</Typography>
        <Typography variant="body2" color="text.secondary">
          Active configuration values by category. Sensitive secrets are managed via AWS Secrets Manager.
        </Typography>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {/* ── Setup Status card ─────────────────────────────────────────────── */}
      <Accordion
        expanded={expanded === 'setup'}
        onChange={handleChange('setup')}
        elevation={0}
        sx={{ mb: 1.5, border: '1px solid', borderColor: allDone ? 'success.light' : 'divider', borderRadius: '8px !important', '&:before': { display: 'none' } }}
      >
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Security color={allDone ? 'success' : 'action'} />
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>Setup Status</Typography>
              <Typography variant="caption" color="text.secondary">Onboarding wizard progress</Typography>
            </Box>
            {allDone && <Chip label="Complete" color="success" size="small" sx={{ ml: 1 }} />}
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {setupItems.map((s) => (
              <Box key={s.key} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                {s.done
                  ? <CheckCircle sx={{ fontSize: 18, color: 'success.main' }} />
                  : <RadioButtonUnchecked sx={{ fontSize: 18, color: 'text.disabled' }} />}
                <Typography variant="body2" color={s.done ? 'text.primary' : 'text.secondary'}>
                  {s.label}
                </Typography>
              </Box>
            ))}
          </Box>
        </AccordionDetails>
      </Accordion>

      {/* ── Config sections ───────────────────────────────────────────────── */}
      {SECTIONS.map((section) => {
        const sectionItems = section.keys
          .map((k) => byKey[k])
          .filter(Boolean) as ConfigItem[];

        return (
          <Accordion
            key={section.id}
            expanded={expanded === section.id}
            onChange={handleChange(section.id)}
            elevation={0}
            sx={{ mb: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: '8px !important', '&:before': { display: 'none' } }}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ color: 'primary.main' }}>{section.icon}</Box>
                <Box>
                  <Typography variant="subtitle2" fontWeight={700}>{section.label}</Typography>
                  <Typography variant="caption" color="text.secondary">{section.description}</Typography>
                </Box>
                <Chip
                  label={`${sectionItems.filter(i => i.value).length} / ${section.keys.length}`}
                  size="small"
                  variant="outlined"
                  sx={{ ml: 1, fontSize: 11 }}
                />
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>
              {sectionItems.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  No values configured for this section yet.
                </Typography>
              ) : (
                sectionItems.map((item) => (
                  <ConfigField
                    key={item.key}
                    item={item}
                    onSave={(key, value) => updateMutation.mutate({ key, value })}
                    saving={savingKey === item.key}
                  />
                ))
              )}
            </AccordionDetails>
          </Accordion>
        );
      })}

      {/* ── Any keys not covered by sections ─────────────────────────────── */}
      {(() => {
        const knownKeys = new Set([
          ...SECTIONS.flatMap((s) => s.keys),
          ...SETUP_KEYS.map((s) => s.key),
        ]);
        const other = items.filter((i) => !knownKeys.has(i.key));
        if (other.length === 0) return null;
        return (
          <Accordion
            expanded={expanded === 'other'}
            onChange={handleChange('other')}
            elevation={0}
            sx={{ mb: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: '8px !important', '&:before': { display: 'none' } }}
          >
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Typography variant="subtitle2" fontWeight={700}>Other</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>
              {other.map((item) => (
                <ConfigField
                  key={item.key}
                  item={item}
                  onSave={(key, value) => updateMutation.mutate({ key, value })}
                  saving={savingKey === item.key}
                />
              ))}
            </AccordionDetails>
          </Accordion>
        );
      })()}
    </Box>
  );
}
