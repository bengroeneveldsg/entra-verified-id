import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Grid,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import AppsIcon from '@mui/icons-material/Apps';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import { useNavigate } from 'react-router-dom';
import { getApiBase } from '../api';

interface SamlApp {
  id: string;
  displayName: string;
  description?: string;
}

// ── App card ─────────────────────────────────────────────────────────────────

function AppCard({ app, onClick }: { app: SamlApp; onClick: () => void }) {
  const theme = useTheme();
  return (
    <Card
      elevation={0}
      sx={{
        height: '100%',
        borderRadius: 3,
        border: `1px solid ${alpha(theme.palette.divider, 0.8)}`,
        transition: 'border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease',
        '&:hover': {
          borderColor: theme.palette.primary.main,
          boxShadow: `0 0 0 1px ${theme.palette.primary.main}, 0 8px 32px ${alpha(theme.palette.primary.main, 0.12)}`,
          transform: 'translateY(-2px)',
        },
      }}
    >
      <CardActionArea
        onClick={onClick}
        sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', p: 0 }}
      >
        <CardContent sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, width: '100%', height: '100%' }}>
          {/* Icon */}
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: 2,
              backgroundColor: alpha(theme.palette.primary.main, 0.08),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.palette.primary.main,
            }}
          >
            <AppsIcon sx={{ fontSize: 24 }} />
          </Box>

          {/* Text */}
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom sx={{ lineHeight: 1.3 }}>
              {app.displayName}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.65 }}>
              {app.description
                ? app.description.length > 100
                  ? `${app.description.slice(0, 100)}…`
                  : app.description
                : 'Sign in with your Verified ID credential. No password required.'}
            </Typography>
          </Box>

          {/* CTA */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              color: 'primary.main',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            <LockOpenOutlinedIcon sx={{ fontSize: 16 }} />
            <Typography variant="caption" fontWeight={700} color="primary.main">
              Sign in
            </Typography>
            <ArrowForwardIcon sx={{ fontSize: 14, ml: 'auto' }} />
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Landing() {
  const navigate = useNavigate();
  const theme = useTheme();
  const [samlApps, setSamlApps] = useState<SamlApp[]>([]);
  const [loadingApps, setLoadingApps] = useState(true);

  useEffect(() => {
    fetch(`${getApiBase()}/api/saml/apps`)
      .then((r) => r.json())
      .then((data) => setSamlApps(data.apps ?? []))
      .catch(() => setSamlApps([]))
      .finally(() => setLoadingApps(false));
  }, []);

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        backgroundColor: theme.palette.background.default,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── Header bar ────────────────────────────────────────────────── */}
      <Box
        component="header"
        sx={{
          borderBottom: `1px solid ${theme.palette.divider}`,
          backgroundColor: alpha(theme.palette.background.paper, 0.85),
          backdropFilter: 'blur(12px)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <Container maxWidth="lg">
          <Box sx={{ height: 56, display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box
              sx={{
                width: 32,
                height: 32,
                borderRadius: '8px',
                background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ShieldOutlinedIcon sx={{ fontSize: 18, color: '#fff' }} />
            </Box>
            <Typography variant="subtitle1" fontWeight={700} sx={{ letterSpacing: '-0.01em' }}>
              Verified ID
            </Typography>
            <Chip
              label="Passwordless"
              size="small"
              sx={{
                ml: 0.5,
                height: 20,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.04em',
                backgroundColor: alpha(theme.palette.primary.main, 0.08),
                color: theme.palette.primary.main,
                border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
              }}
            />
          </Box>
        </Container>
      </Box>

      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        <Container maxWidth="lg" sx={{ pt: { xs: 5, md: 7 }, pb: { xs: 8, md: 10 }, flexGrow: 1 }}>

          {/* ── Zone 1: Credential onboarding ───────────────────────────── */}
          <Box
            sx={{
              mb: { xs: 6, md: 8 },
              p: { xs: 3, md: 4 },
              borderRadius: 3,
              background: `linear-gradient(120deg,
                ${alpha(theme.palette.primary.main, 0.04)} 0%,
                ${alpha(theme.palette.secondary.main, 0.06)} 100%)`,
              border: `1px solid ${alpha(theme.palette.primary.main, 0.12)}`,
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              alignItems: { xs: 'flex-start', sm: 'center' },
              gap: 3,
            }}
          >
            {/* Icon */}
            <Box
              sx={{
                width: 52,
                height: 52,
                borderRadius: '14px',
                flexShrink: 0,
                background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: `0 4px 16px ${alpha(theme.palette.primary.main, 0.28)}`,
              }}
            >
              <BadgeOutlinedIcon sx={{ fontSize: 26, color: '#fff' }} />
            </Box>

            {/* Text */}
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Stack direction="row" alignItems="center" gap={1} mb={0.5}>
                <Typography variant="subtitle1" fontWeight={700}>
                  First time here?
                </Typography>
                <Chip
                  label="One-time setup"
                  size="small"
                  sx={{
                    height: 20,
                    fontSize: 10,
                    fontWeight: 600,
                    backgroundColor: alpha(theme.palette.secondary.main, 0.10),
                    color: theme.palette.secondary.dark,
                    border: `1px solid ${alpha(theme.palette.secondary.main, 0.25)}`,
                  }}
                />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
                Before you can sign in to your applications, you need to set up your digital credential
                in Microsoft Authenticator. This is a one-time step — scan the QR code and you're ready.
              </Typography>
            </Box>

            {/* CTA */}
            <Button
              variant="contained"
              endIcon={<ArrowForwardIcon />}
              onClick={() => navigate('/issue')}
              sx={{
                flexShrink: 0,
                fontWeight: 700,
                px: 3,
                borderRadius: 2,
                background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
                boxShadow: `0 4px 16px ${alpha(theme.palette.primary.main, 0.32)}`,
                '&:hover': {
                  boxShadow: `0 6px 20px ${alpha(theme.palette.primary.main, 0.44)}`,
                  background: `linear-gradient(135deg, ${theme.palette.primary.dark}, ${theme.palette.secondary.dark})`,
                },
              }}
            >
              Get credential
            </Button>
          </Box>

          {/* ── Zone 2: Applications ────────────────────────────────────── */}
          <Box>
            {/* Section header */}
            <Box sx={{ mb: 3, display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
              <Typography variant="h6" fontWeight={700} sx={{ letterSpacing: '-0.02em' }}>
                Your Applications
              </Typography>
              {!loadingApps && samlApps.length > 0 && (
                <Typography variant="body2" color="text.disabled">
                  {samlApps.length} app{samlApps.length !== 1 ? 's' : ''}
                </Typography>
              )}
            </Box>

            {/* App grid */}
            {loadingApps ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                <CircularProgress size={32} />
              </Box>
            ) : samlApps.length === 0 ? (
              <Box
                sx={{
                  py: 8,
                  textAlign: 'center',
                  borderRadius: 3,
                  border: `1px dashed ${theme.palette.divider}`,
                }}
              >
                <AppsIcon sx={{ fontSize: 40, color: 'text.disabled', mb: 1.5 }} />
                <Typography variant="body1" fontWeight={600} color="text.secondary" gutterBottom>
                  No applications yet
                </Typography>
                <Typography variant="body2" color="text.disabled">
                  Applications will appear here once they have been added by your administrator.
                </Typography>
              </Box>
            ) : (
              <Grid container spacing={2.5}>
                {samlApps.map((app) => (
                  <Grid key={app.id} item xs={12} sm={6} md={4} lg={3}>
                    <AppCard
                      app={app}
                      onClick={() => navigate(`/saml?app=${app.id}`)}
                    />
                  </Grid>
                ))}
              </Grid>
            )}
          </Box>
        </Container>
      </Box>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <Box
        component="footer"
        sx={{
          py: 3,
          textAlign: 'center',
          borderTop: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Typography variant="caption" color="text.disabled">
          Secured by{' '}
          <Box
            component="a"
            href="https://learn.microsoft.com/en-us/entra/verified-id/"
            target="_blank"
            rel="noopener noreferrer"
            sx={{ color: 'inherit', textDecoration: 'underline' }}
          >
            Microsoft Entra Verified ID
          </Box>
        </Typography>
      </Box>
    </Box>
  );
}
