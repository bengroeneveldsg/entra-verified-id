import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  Divider,
  Grid,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import BadgeIcon from '@mui/icons-material/Badge';
import AppsIcon from '@mui/icons-material/Apps';
import SecurityIcon from '@mui/icons-material/Security';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useNavigate } from 'react-router-dom';
import { getApiBase } from '../api';

interface SamlApp {
  id: string;
  displayName: string;
  description?: string;
}

export default function Landing() {
  const navigate = useNavigate();
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
        background: (theme) =>
          `radial-gradient(ellipse at 60% 0%, ${alpha(theme.palette.primary.light, 0.18)} 0%, ${theme.palette.background.default} 60%)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── Hero ──────────────────────────���──────────────────────── */}
      <Container maxWidth="lg" sx={{ pt: { xs: 8, md: 12 }, pb: { xs: 6, md: 8 } }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 3 }}>
          <Box
            sx={{
              width: 72,
              height: 72,
              borderRadius: '20px',
              background: (theme) =>
                `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.secondary.main} 100%)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: (theme) => `0 8px 28px ${alpha(theme.palette.primary.main, 0.38)}`,
            }}
          >
            <SecurityIcon sx={{ fontSize: 38, color: '#fff' }} />
          </Box>

          <Box>
            <Typography
              variant="h3"
              component="h1"
              sx={{
                fontWeight: 800,
                letterSpacing: '-0.03em',
                background: (theme) =>
                  `linear-gradient(135deg, ${theme.palette.primary.dark} 0%, ${theme.palette.secondary.main} 100%)`,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                mb: 1,
              }}
            >
              Verified ID
            </Typography>
            <Typography
              variant="h6"
              color="text.secondary"
              sx={{ fontWeight: 400, maxWidth: 520, mx: 'auto', lineHeight: 1.7 }}
            >
              Passwordless authentication powered by{' '}
              <Box component="span" sx={{ color: 'primary.main', fontWeight: 600 }}>
                Microsoft Entra Verified ID
              </Box>
              . Secure, fast, and credential-first.
            </Typography>
          </Box>

          <Divider sx={{ width: 64, borderColor: 'primary.main', borderBottomWidth: 3, borderRadius: 2 }} />
        </Box>
      </Container>

      {/* ── Cards ──────────────────────────��─────────────────────── */}
      <Container maxWidth="lg" sx={{ pb: { xs: 8, md: 12 }, flexGrow: 1 }}>
        <Grid container spacing={3} justifyContent="center">

          {/* Credential Issuance — always shown */}
          <Grid item xs={12} sm={6} md={4}>
            <Card
              elevation={0}
              sx={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: '16px',
                border: (theme) => `1px solid ${alpha('#6A1B9A', 0.15)}`,
                boxShadow: `0 4px 24px ${alpha('#6A1B9A', 0.10)}`,
                transition: 'transform 0.18s ease, box-shadow 0.18s ease',
                '&:hover': { transform: 'translateY(-4px)', boxShadow: `0 12px 40px ${alpha('#6A1B9A', 0.20)}` },
              }}
            >
              <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2, p: 3 }}>
                <Box
                  sx={{
                    width: 56, height: 56, borderRadius: '14px',
                    backgroundColor: alpha('#6A1B9A', 0.10),
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6A1B9A',
                  }}
                >
                  <BadgeIcon sx={{ fontSize: 32 }} />
                </Box>
                <Box sx={{ flexGrow: 1 }}>
                  <Typography variant="h6" component="h2" sx={{ fontWeight: 700, mb: 1 }}>
                    Get Your Credential
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                    Receive a tamper-proof Verified Employee credential into Microsoft Authenticator with one scan.
                  </Typography>
                </Box>
                <Button
                  variant="contained"
                  endIcon={<ArrowForwardIcon />}
                  onClick={() => navigate('/issue')}
                  sx={{
                    alignSelf: 'flex-start',
                    backgroundColor: '#6A1B9A',
                    '&:hover': { backgroundColor: alpha('#6A1B9A', 0.85) },
                    mt: 1,
                  }}
                >
                  Get credential
                </Button>
              </CardContent>
            </Card>
          </Grid>

          {/* SAML app tiles — one per enabled app */}
          {loadingApps ? (
            <Grid item xs={12} sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
              <CircularProgress size={32} />
            </Grid>
          ) : (
            samlApps.map((app) => (
              <Grid key={app.id} item xs={12} sm={6} md={4}>
                <Card
                  elevation={0}
                  sx={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: '16px',
                    border: (theme) => `1px solid ${alpha('#00897B', 0.15)}`,
                    boxShadow: `0 4px 24px ${alpha('#00897B', 0.10)}`,
                    transition: 'transform 0.18s ease, box-shadow 0.18s ease',
                    '&:hover': { transform: 'translateY(-4px)', boxShadow: `0 12px 40px ${alpha('#00897B', 0.20)}` },
                  }}
                >
                  <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2, p: 3 }}>
                    <Box
                      sx={{
                        width: 56, height: 56, borderRadius: '14px',
                        backgroundColor: alpha('#00897B', 0.10),
                        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00897B',
                      }}
                    >
                      <AppsIcon sx={{ fontSize: 32 }} />
                    </Box>
                    <Box sx={{ flexGrow: 1 }}>
                      <Typography variant="h6" component="h2" sx={{ fontWeight: 700, mb: 1 }}>
                        {app.displayName}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                        {app.description
                          ? app.description.length > 100
                            ? `${app.description.slice(0, 100)}…`
                            : app.description
                          : 'Sign in with your Verified ID credential. No password required.'}
                      </Typography>
                    </Box>
                    <Button
                      variant="contained"
                      endIcon={<ArrowForwardIcon />}
                      onClick={() => navigate(`/saml?app=${app.id}`)}
                      sx={{
                        alignSelf: 'flex-start',
                        backgroundColor: '#00897B',
                        '&:hover': { backgroundColor: alpha('#00897B', 0.85) },
                        mt: 1,
                      }}
                    >
                      Sign in
                    </Button>
                  </CardContent>
                </Card>
              </Grid>
            ))
          )}
        </Grid>
      </Container>

      {/* ── Footer ──────────────────────────���────────────────────── */}
      <Box component="footer" sx={{ py: 3, textAlign: 'center', borderTop: (theme) => `1px solid ${theme.palette.divider}` }}>
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
