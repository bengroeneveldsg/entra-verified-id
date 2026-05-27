import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  LinearProgress,
  Typography,
  Zoom,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ReplayIcon from '@mui/icons-material/Replay';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import HomeIcon from '@mui/icons-material/Home';
import CheckIcon from '@mui/icons-material/Check';
import { useNavigate } from 'react-router-dom';
import { FlowCard, QrDisplay, StatusBadge } from '@entra-vid/shared-ui';
import { issueStart, loginStatus } from '../api';

// ---------------------------------------------------------------------------
type FlowState = 'loading' | 'pending' | 'scanning' | 'success' | 'failed' | 'expired';

const POLL_INTERVAL_MS = 2_000;
const EXPIRY_SECONDS  = 600;

function fmtTime(s: number) {
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function StepDot({ active, done }: { active: boolean; done: boolean }) {
  const theme = useTheme();
  return (
    <Box sx={{
      width: 24, height: 24, borderRadius: '50%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 11, fontWeight: 700, flexShrink: 0, transition: 'all 0.2s ease',
      ...(done
        ? { backgroundColor: theme.palette.success.main, color: '#fff' }
        : active
        ? { backgroundColor: theme.palette.primary.main, color: '#fff' }
        : { backgroundColor: alpha(theme.palette.text.primary, 0.08), color: theme.palette.text.disabled }),
    }}>
      {done ? <CheckIcon sx={{ fontSize: 14 }} /> : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------

export default function Issue() {
  const theme    = useTheme();
  const navigate = useNavigate();

  const [flowState, setFlowState] = useState<FlowState>('loading');
  const [qrCode,    setQrCode]    = useState('');
  const [deepLink,  setDeepLink]  = useState('');
  const [errorMsg,  setErrorMsg]  = useState('');
  const [secondsLeft, setSecondsLeft] = useState(EXPIRY_SECONDS);

  const requestIdRef   = useRef<string | null>(null);
  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimers = useCallback(() => {
    if (pollRef.current)     { clearInterval(pollRef.current);     pollRef.current     = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  }, []);

  const poll = useCallback(async () => {
    const id = requestIdRef.current;
    if (!id) return;
    try {
      const data = await loginStatus(id);
      const s = data.status;
      if      (s === 'request_retrieved')                               setFlowState('scanning');
      else if (s === 'issuance_successful' || s === 'claimed' || s === 'success') { stopTimers(); setFlowState('success'); }
      else if (s === 'issuance_error'      || s === 'failed'  || s === 'error')   { stopTimers(); setErrorMsg(data.failureReason ?? 'Issuance failed.'); setFlowState('failed'); }
    } catch { /* keep polling */ }
  }, [stopTimers]);

  const start = useCallback(async () => {
    stopTimers();
    requestIdRef.current = null;
    setFlowState('loading');
    setQrCode(''); setDeepLink(''); setErrorMsg('');
    try {
      const data = await issueStart();
      requestIdRef.current = data.requestId;
      setQrCode(data.qrCode);
      setDeepLink(data.url);
      setFlowState('pending');
      setSecondsLeft(EXPIRY_SECONDS);
      countdownRef.current = setInterval(() => {
        setSecondsLeft((p) => { if (p <= 1) { stopTimers(); setFlowState('expired'); return 0; } return p - 1; });
      }, 1_000);
      pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not start issuance.');
      setFlowState('failed');
    }
  }, [stopTimers, poll]);

  useEffect(() => { start(); return stopTimers; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // ── Success screen ─────────────────────────────────────────────────────────
  if (flowState === 'success') {
    return (
      <FlowCard title="" subtitle="">
        <Zoom in>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, py: 2, width: '100%' }}>
            <Box sx={{
              width: 80, height: 80, borderRadius: '50%',
              background: `linear-gradient(135deg, ${theme.palette.success.light}, ${theme.palette.success.main})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: `0 8px 28px ${alpha(theme.palette.success.main, 0.38)}`,
            }}>
              <VerifiedUserIcon sx={{ fontSize: 44, color: '#fff' }} />
            </Box>
            <Box sx={{ textAlign: 'center' }}>
              <Typography variant="h5" fontWeight={800} color="success.dark" gutterBottom sx={{ letterSpacing: '-0.02em' }}>
                You're all set!
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7, maxWidth: 320, mx: 'auto' }}>
                Your Verified Employee credential is now in Microsoft Authenticator.
                You can use it to sign in to any connected application.
              </Typography>
            </Box>
            <Box sx={{
              width: '100%', p: 2, borderRadius: 2,
              backgroundColor: alpha(theme.palette.success.main, 0.06),
              border: `1px solid ${alpha(theme.palette.success.main, 0.2)}`,
            }}>
              {['Name', 'Job title', 'Email'].map((claim) => (
                <Box key={claim} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
                  <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                  <Typography variant="caption" color="text.secondary">{claim} claim included</Typography>
                </Box>
              ))}
            </Box>
            <Button variant="contained" startIcon={<HomeIcon />} onClick={() => navigate('/')} fullWidth sx={{ borderRadius: 2, fontWeight: 700 }}>
              Go to your applications
            </Button>
          </Box>
        </Zoom>
      </FlowCard>
    );
  }

  // ── Main card ──────────────────────────────────────────────────────────────
  const step1done = ['pending', 'scanning', 'success'].includes(flowState);
  const step2done = ['scanning', 'success'].includes(flowState);

  return (
    <FlowCard
      title="Get Your Credential"
      subtitle="One-time setup — scan with Microsoft Authenticator to add your Verified Employee credential."
      onClose={() => { stopTimers(); navigate('/'); }}
    >
      {/* Step indicator */}
      <Box sx={{ width: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
          <StepDot active={flowState === 'loading'} done={step1done} />
          <Box sx={{ flex: 1, height: 2, mx: 0.5, backgroundColor: step1done ? 'success.main' : 'divider', transition: 'background-color 0.3s' }} />
          <StepDot active={flowState === 'pending'} done={step2done} />
          <Box sx={{ flex: 1, height: 2, mx: 0.5, backgroundColor: step2done ? 'success.main' : 'divider', transition: 'background-color 0.3s' }} />
          <StepDot active={flowState === 'scanning'} done={false} />
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
          {['Open app', 'Scan QR', 'Accept'].map((label) => (
            <Typography key={label} variant="caption" color="text.disabled" sx={{ fontSize: 10, textAlign: 'center', width: 24 }}>
              {label}
            </Typography>
          ))}
        </Box>
      </Box>

      <Divider sx={{ width: '100%' }} />

      {flowState === 'loading' && (
        <Box sx={{ width: '100%', textAlign: 'center' }}>
          <LinearProgress sx={{ borderRadius: 1 }} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>Preparing your credential offer…</Typography>
        </Box>
      )}

      {(flowState === 'pending' || flowState === 'scanning') && (
        <>
          <QrDisplay qrCode={qrCode} deepLink={deepLink} />
          <StatusBadge status={flowState === 'scanning' ? 'claimed' : 'pending'} />
          <Typography variant="body2" color="text.secondary" align="center">
            {flowState === 'scanning' ? 'Credential offer accepted — issuing now…' : 'Open Microsoft Authenticator and scan the code above'}
          </Typography>
          {flowState === 'pending' && (
            <Typography variant="caption" color="text.disabled">
              Offer expires in{' '}
              <Box component="span" sx={{ color: secondsLeft < 60 ? 'warning.main' : 'text.secondary', fontWeight: 600 }}>
                {fmtTime(secondsLeft)}
              </Box>
            </Typography>
          )}
        </>
      )}

      {flowState === 'failed' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
          <Alert severity="error" sx={{ width: '100%' }}>{errorMsg || 'Credential issuance failed.'}</Alert>
          <Button variant="outlined" startIcon={<ReplayIcon />} onClick={start} fullWidth>Try Again</Button>
        </Box>
      )}

      {flowState === 'expired' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
          <Alert severity="warning" sx={{ width: '100%' }}>The credential offer has expired after 10 minutes.</Alert>
          <Button variant="outlined" startIcon={<ReplayIcon />} onClick={start} fullWidth>Generate New Offer</Button>
        </Box>
      )}
    </FlowCard>
  );
}
