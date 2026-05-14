import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import ReplayIcon from '@mui/icons-material/Replay';
import ComputerIcon from '@mui/icons-material/Computer';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { FlowCard, QrDisplay, StatusBadge } from '@entra-vid/shared-ui';
import { getApiBase, loginStatus } from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FlowState =
  | 'loading'
  | 'pending'
  | 'scanning'
  | 'completing'
  | 'submitting'
  | 'failed'
  | 'expired';

const POLL_INTERVAL_MS = 2_000;
const EXPIRY_SECONDS = 600;

// ---------------------------------------------------------------------------
// Inline API calls that match saml.html exactly
//
// POST /api/saml/initiate?app=<appId>         → { sessionId }
// GET  /api/saml/complete?session=S&vid=V     → { samlResponse, acsUrl, relayState? }
//   ↳ 202 means "still pending" — retry with back-off (max 15 × 2 s)
// POST /api/login/start                       → { requestId, qrCode, url }
// GET  /api/login/status/:id                  → { status, ... }
// ---------------------------------------------------------------------------

interface SamlInitiateResponse {
  sessionId: string;
  displayName?: string;
}

interface SamlCompleteResponse {
  samlResponse: string;
  acsUrl: string;
  relayState?: string;
}

async function samlInitiate(appId: string): Promise<SamlInitiateResponse> {
  const res = await fetch(
    `${getApiBase()}/api/saml/initiate?app=${encodeURIComponent(appId)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SamlInitiateResponse>;
}

interface RawLoginStart {
  requestId: string;
  qrCode: string;
  url: string;
}

async function samlLoginStart(): Promise<RawLoginStart> {
  const res = await fetch(`${getApiBase()}/api/login/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<RawLoginStart>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(s: number): string {
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/**
 * Resolve the app ID.
 * Precedence: ?app= URL param → subdomain of example.com → fallback "kiro"
 */
function resolveAppId(searchParams: URLSearchParams): string {
  const urlApp = searchParams.get('app');
  if (urlApp) return urlApp;

  const hostname = window.location.hostname;
  const baseDomain = 'example.com';
  if (hostname.endsWith('.' + baseDomain)) {
    return hostname.slice(0, hostname.length - baseDomain.length - 1);
  }
  return 'kiro';
}

/**
 * Create and submit a hidden form that POST-s the SAML response to the ACS URL.
 * This is the standard SP-initiated SAML redirect pattern.
 */
function submitSamlForm(
  samlResponse: string,
  acsUrl: string,
  relayState?: string,
): void {
  const container = document.createElement('div');
  container.style.display = 'none';
  document.body.appendChild(container);

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = acsUrl;

  const samlInput = document.createElement('input');
  samlInput.type = 'hidden';
  samlInput.name = 'SAMLResponse';
  samlInput.value = samlResponse;
  form.appendChild(samlInput);

  if (relayState) {
    const rsInput = document.createElement('input');
    rsInput.type = 'hidden';
    rsInput.name = 'RelayState';
    rsInput.value = relayState;
    form.appendChild(rsInput);
  }

  container.appendChild(form);
  form.submit();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Saml() {
  const navigate = useNavigate();
  const theme = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();

  const [flowState, setFlowState] = useState<FlowState>('loading');
  const [qrCode, setQrCode] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(EXPIRY_SECONDS);
  const [appDisplayName, setAppDisplayName] = useState<string>('');

  const samlSessionRef = useRef<string>(searchParams.get('session') ?? '');
  const vidRequestIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completingRef = useRef(false);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  const stopTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  }, []);

  const showError = useCallback((msg: string) => {
    stopTimers();
    completingRef.current = false;
    setErrorMsg(msg);
    setFlowState('failed');
  }, [stopTimers]);

  // ── Complete: poll /api/saml/complete with back-off ──────────────────────
  const callComplete = useCallback(async () => {
    const session = samlSessionRef.current;
    const vid = vidRequestIdRef.current;
    if (!session || !vid) {
      showError('Missing session or VID request ID.');
      return;
    }

    const url = `${getApiBase()}/api/saml/complete?session=${encodeURIComponent(session)}&vid=${encodeURIComponent(vid)}`;
    let attempts = 0;
    const MAX_ATTEMPTS = 15;

    async function attempt(): Promise<void> {
      attempts++;
      try {
        const res = await fetch(url);

        if (res.status === 202) {
          // Lambda still signing the assertion — retry
          if (attempts < MAX_ATTEMPTS) {
            setTimeout(attempt, 2_000);
          } else {
            showError('Timed out waiting for SAML assertion. Please try again.');
          }
          return;
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          showError(body.error ?? `Sign-in failed (HTTP ${res.status}). Please try again.`);
          return;
        }

        const data = await res.json() as SamlCompleteResponse;
        setFlowState('submitting');
        submitSamlForm(data.samlResponse, data.acsUrl, data.relayState);
      } catch {
        showError('Network error during sign-in. Please try again.');
      }
    }

    setFlowState('completing');
    await attempt();
  }, [showError]);

  // ── Poll VID status ──────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    const id = vidRequestIdRef.current;
    if (!id) return;
    try {
      const data = await loginStatus(id);
      const s = data.status;

      if (s === 'request_retrieved') {
        setFlowState('scanning');
      } else if (s === 'claimed' || s === 'success') {
        stopTimers();
        setFlowState('scanning');
        if (!completingRef.current) {
          completingRef.current = true;
          await callComplete();
        }
      } else if (s === 'failed' || s === 'error') {
        showError(data.failureReason ?? 'Verification failed. Please try again.');
      }
      // 'pending' → keep polling
    } catch {
      // Network blip — keep polling
    }
  }, [stopTimers, callComplete, showError]);

  // ── Start flow ───────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    stopTimers();
    vidRequestIdRef.current = null;
    completingRef.current = false;
    setFlowState('loading');
    setQrCode('');
    setDeepLink('');
    setErrorMsg('');

    // Step 1 — ensure we have a SAML session ID
    if (!samlSessionRef.current) {
      try {
        const appId = resolveAppId(searchParams);
        const data = await samlInitiate(appId);
        if (!data.sessionId) {
          showError('Could not start sign-in. Please try again.');
          return;
        }
        samlSessionRef.current = data.sessionId;
        if (data.displayName) setAppDisplayName(data.displayName);
        // Persist session ID in the URL so a page refresh works
        const next = new URLSearchParams(searchParams);
        next.set('session', data.sessionId);
        setSearchParams(next, { replace: true });
      } catch {
        showError('Could not start sign-in. Please try again.');
        return;
      }
    }

    // Step 2 — start a VID presentation request
    try {
      const data = await samlLoginStart();
      vidRequestIdRef.current = data.requestId;
      setQrCode(data.qrCode);
      setDeepLink(data.url);
      setFlowState('pending');

      setSecondsLeft(EXPIRY_SECONDS);
      countdownRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev <= 1) {
            stopTimers();
            setFlowState('expired');
            return 0;
          }
          return prev - 1;
        });
      }, 1_000);

      pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    } catch {
      showError('Could not start sign-in. Please try again.');
    }
  }, [searchParams, setSearchParams, stopTimers, poll, showError]);

  useEffect(() => {
    start();
    return stopTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared glassmorphism card styles (mirrors FlowCard's inner card)
  const cardSx = {
    width: '100%',
    maxWidth: 480,
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    backgroundColor: alpha('#ffffff', 0.90),
    border: `1px solid ${alpha(theme.palette.primary.main, 0.12)}`,
    boxShadow: `0 8px 40px ${alpha(theme.palette.primary.dark, 0.12)}`,
    borderRadius: '20px',
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    // Shared full-viewport centred column — holds both cards
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        px: 2,
        py: 4,
        background: `radial-gradient(ellipse at 50% 0%, ${alpha(theme.palette.primary.light, 0.15)} 0%, ${theme.palette.background.default} 65%)`,
      }}
    >
      {/* ── Companion card — "Don't have a Verified ID?" ─────────── */}
      <Box sx={{ ...cardSx, px: 3, py: 2.5, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: '10px',
            flexShrink: 0,
            background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <BadgeOutlinedIcon sx={{ fontSize: 20, color: '#fff' }} />
        </Box>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" fontWeight={700} sx={{ lineHeight: 1.3 }}>
            Don't have a Verified ID yet?
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Get your credential in Microsoft Authenticator first.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          endIcon={<ArrowForwardIcon sx={{ fontSize: 14 }} />}
          onClick={() => navigate('/issue')}
          sx={{ flexShrink: 0, fontWeight: 700, borderRadius: 1.5 }}
        >
          Get credential
        </Button>
      </Box>

      {/* ── QR card — FlowCard with viewport-centering disabled ─────── */}
      <FlowCard
        title={appDisplayName ? `Sign In to ${appDisplayName}` : 'Sign In'}
        subtitle="Scan the QR code with Microsoft Authenticator to authenticate."
        sx={{ minHeight: 'auto', py: 0, px: 0, background: 'transparent' }}
      >
      {/* Loading */}
      {flowState === 'loading' && (
        <Box sx={{ width: '100%' }}>
          <LinearProgress />
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 1.5 }}>
            Generating sign-in code…
          </Typography>
        </Box>
      )}

      {/* QR */}
      {(flowState === 'pending' || flowState === 'scanning') && (
        <>
          <QrDisplay qrCode={qrCode} deepLink={deepLink} />
          <StatusBadge status={flowState === 'scanning' ? 'claimed' : 'pending'} />
          <Typography variant="body2" color="text.secondary" align="center">
            {flowState === 'scanning'
              ? 'Credential detected — verifying…'
              : 'Waiting for authentication…'}
          </Typography>
          {flowState === 'pending' && (
            <Typography variant="caption" color="text.disabled">
              Code expires in{' '}
              <Box
                component="span"
                sx={{ color: secondsLeft < 60 ? 'warning.main' : 'text.secondary', fontWeight: 600 }}
              >
                {fmtTime(secondsLeft)}
              </Box>
            </Typography>
          )}
        </>
      )}

      {/* Completing / Submitting */}
      {(flowState === 'completing' || flowState === 'submitting') && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, py: 2, width: '100%' }}>
          <ComputerIcon sx={{ fontSize: 56, color: 'primary.main' }} />
          <LinearProgress sx={{ width: '100%' }} />
          <Typography variant="body1" sx={{ fontWeight: 600 }} color="success.main">
            {flowState === 'submitting'
              ? `Opening ${appDisplayName || 'your app'}…`
              : 'Completing verification…'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            You will be redirected automatically.
          </Typography>
        </Box>
      )}

      {/* Failed */}
      {flowState === 'failed' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
          <Alert severity="error" sx={{ width: '100%' }}>
            {errorMsg || 'Something went wrong. Please try again.'}
          </Alert>
          <Button variant="outlined" startIcon={<ReplayIcon />} onClick={start}>
            Try Again
          </Button>
        </Box>
      )}

      {/* Expired */}
      {flowState === 'expired' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
          <Alert severity="warning" sx={{ width: '100%' }}>
            The QR code has expired after 10 minutes.
          </Alert>
          <Button variant="outlined" startIcon={<ReplayIcon />} onClick={start}>
            Generate New Code
          </Button>
        </Box>
      )}
      </FlowCard>
    </Box>
  );
}
