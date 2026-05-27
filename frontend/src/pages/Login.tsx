import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Step,
  StepLabel,
  Stepper,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ReplayIcon from '@mui/icons-material/Replay';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useNavigate } from 'react-router-dom';
import { FlowCard, QrDisplay, StatusBadge } from '@entra-vid/shared-ui';
import { loginStart, loginStatus } from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FlowState =
  | 'loading'
  | 'pending'
  | 'scanning'
  | 'success'
  | 'failed'
  | 'expired';

const POLL_INTERVAL_MS = 2_000;
const EXPIRY_SECONDS = 600; // 10 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const STEPS = ['Scan QR', 'Verify Credential', 'Complete'];

function stepIndex(state: FlowState): number {
  if (state === 'loading' || state === 'pending') return 0;
  if (state === 'scanning') return 1;
  return 2;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Login() {
  const navigate = useNavigate();
  const theme = useTheme();
  const [flowState, setFlowState] = useState<FlowState>('loading');
  const [qrCode, setQrCode] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(EXPIRY_SECONDS);

  const requestIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Cleanup ────────────────────────────────────────────────────────────
  const stopTimers = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  // ── Start countdown ─────────────────────────────────────────────────────
  const startCountdown = useCallback(() => {
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
  }, [stopTimers]);

  // ── Poll VID status ─────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    const id = requestIdRef.current;
    if (!id) return;
    try {
      const data = await loginStatus(id);
      const s = data.status;

      if (s === 'request_retrieved') {
        setFlowState('scanning');
      } else if (s === 'claimed' || s === 'success') {
        stopTimers();
        const name =
          (data.claims?.['vc.credentialSubject.displayName'] as string) ??
          (data.claims?.['displayName'] as string) ??
          '';
        setDisplayName(name);
        setFlowState('success');
      } else if (s === 'failed' || s === 'error') {
        stopTimers();
        setErrorMsg(data.failureReason ?? 'Verification failed. Please try again.');
        setFlowState('failed');
      }
      // 'pending' → do nothing, keep polling
    } catch {
      // Network blip — keep polling
    }
  }, [stopTimers]);

  // ── Start / restart flow ────────────────────────────────────────────────
  const start = useCallback(async () => {
    stopTimers();
    requestIdRef.current = null;
    setFlowState('loading');
    setQrCode('');
    setDeepLink('');
    setErrorMsg('');
    setDisplayName('');

    try {
      const data = await loginStart();
      requestIdRef.current = data.requestId;
      setQrCode(data.qrCode);
      setDeepLink(data.url);
      setFlowState('pending');
      startCountdown();
      pollTimerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not start sign-in.';
      setErrorMsg(msg);
      setFlowState('failed');
    }
  }, [stopTimers, startCountdown, poll]);

  useEffect(() => {
    start();
    return stopTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  const active = stepIndex(flowState);

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

  return (
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
      {/* ── Companion card ──────────────────────────────────────────── */}
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

      {/* ── Main QR card ────────────────────────────────────────────── */}
      <FlowCard
        title="Sign In"
        subtitle="Scan the QR code with Microsoft Authenticator to sign in."
        sx={{ minHeight: 'auto', py: 0, px: 0, background: 'transparent' }}
        onClose={() => { stopTimers(); navigate('/'); }}
      >
      {/* Progress stepper */}
      <Stepper activeStep={active} alternativeLabel sx={{ width: '100%' }}>
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {/* ── Loading ── */}
      {flowState === 'loading' && (
        <Box sx={{ width: '100%', mt: 1 }}>
          <LinearProgress />
          <Typography
            variant="body2"
            color="text.secondary"
            align="center"
            sx={{ mt: 1.5 }}
          >
            Generating sign-in code…
          </Typography>
        </Box>
      )}

      {/* ── QR / Pending ── */}
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
            <>
              <LinearProgress sx={{ width: '100%' }} />
              <Typography variant="caption" color="text.disabled">
                Code expires in{' '}
                <Box
                  component="span"
                  sx={{ color: secondsLeft < 60 ? 'warning.main' : 'text.secondary', fontWeight: 600 }}
                >
                  {fmtTime(secondsLeft)}
                </Box>
              </Typography>
            </>
          )}
        </>
      )}

      {/* ── Success ── */}
      {flowState === 'success' && (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1.5,
            py: 2,
          }}
        >
          <CheckCircleIcon sx={{ fontSize: 56, color: 'success.main' }} />
          <Typography variant="h6" sx={{ fontWeight: 700 }} color="success.main">
            Login Successful
          </Typography>
          {displayName && (
            <Typography variant="body2" color="text.secondary">
              Welcome back,{' '}
              <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
                {displayName}
              </Box>
            </Typography>
          )}
          <Alert severity="success" variant="outlined" sx={{ width: '100%', mt: 1 }}>
            You have been authenticated. You may close this window or continue.
          </Alert>
        </Box>
      )}

      {/* ── Failed ── */}
      {flowState === 'failed' && (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            width: '100%',
          }}
        >
          <Alert severity="error" sx={{ width: '100%' }}>
            {errorMsg || 'Verification failed. Please try again.'}
          </Alert>
          <Button
            variant="outlined"
            startIcon={<ReplayIcon />}
            onClick={start}
          >
            Try Again
          </Button>
        </Box>
      )}

      {/* ── Expired ── */}
      {flowState === 'expired' && (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            width: '100%',
          }}
        >
          <Alert severity="warning" sx={{ width: '100%' }}>
            The QR code has expired after 10 minutes.
          </Alert>
          <Button
            variant="outlined"
            startIcon={<ReplayIcon />}
            onClick={start}
          >
            Generate New Code
          </Button>
        </Box>
      )}
      </FlowCard>
    </Box>
  );
}
