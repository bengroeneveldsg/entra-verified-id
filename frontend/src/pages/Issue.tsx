import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Typography,
  Zoom,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ReplayIcon from '@mui/icons-material/Replay';
import { alpha } from '@mui/material/styles';
import { FlowCard, QrDisplay, StatusBadge } from '@entra-vid/shared-ui';
import { issueStart, loginStatus } from '../api';

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
const EXPIRY_SECONDS = 600;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Issue() {
  const [flowState, setFlowState] = useState<FlowState>('loading');
  const [qrCode, setQrCode] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(EXPIRY_SECONDS);

  const requestIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  }, []);

  // ── Poll ──────────────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    const id = requestIdRef.current;
    if (!id) return;
    try {
      const data = await loginStatus(id);
      const s = data.status;

      if (s === 'request_retrieved') {
        setFlowState('scanning');
      } else if (s === 'issuance_successful' || s === 'claimed' || s === 'success') {
        stopTimers();
        setFlowState('success');
      } else if (s === 'issuance_error' || s === 'failed' || s === 'error') {
        stopTimers();
        setErrorMsg(data.failureReason ?? 'Issuance failed. Please try again.');
        setFlowState('failed');
      }
    } catch {
      // Network blip — keep polling
    }
  }, [stopTimers]);

  // ── Start ─────────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    stopTimers();
    requestIdRef.current = null;
    setFlowState('loading');
    setQrCode('');
    setDeepLink('');
    setErrorMsg('');

    try {
      const data = await issueStart();
      requestIdRef.current = data.requestId;
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
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not start issuance.');
      setFlowState('failed');
    }
  }, [stopTimers, poll]);

  useEffect(() => {
    start();
    return stopTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <FlowCard
      title="Get Your Credential"
      subtitle="Scan the QR code with Microsoft Authenticator to receive your Verified Employee credential."
      footer={
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
      }
    >
      {/* Loading */}
      {flowState === 'loading' && (
        <Box sx={{ width: '100%' }}>
          <LinearProgress />
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 1.5 }}>
            Preparing your credential offer…
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
              ? 'Credential offer accepted — issuing…'
              : 'Waiting for Authenticator to scan…'}
          </Typography>
          {flowState === 'pending' && (
            <>
              <LinearProgress sx={{ width: '100%' }} />
              <Typography variant="caption" color="text.disabled">
                Offer expires in{' '}
                <Box
                  component="span"
                  sx={{ color: secondsLeft < 60 ? 'warning.main' : 'text.secondary', fontWeight: 600 }}
                >
                  {`${Math.floor(secondsLeft / 60)}:${(secondsLeft % 60).toString().padStart(2, '0')}`}
                </Box>
              </Typography>
            </>
          )}
        </>
      )}

      {/* Success */}
      {flowState === 'success' && (
        <Zoom in>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              py: 3,
              px: 2,
              borderRadius: 3,
              background: (theme) => alpha(theme.palette.success.main, 0.08),
              border: (theme) => `1px solid ${alpha(theme.palette.success.main, 0.25)}`,
              width: '100%',
            }}
          >
            <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main' }} />
            <Typography variant="h5" sx={{ fontWeight: 800, color: 'success.dark' }}>
              Congratulations!
            </Typography>
            <Typography variant="body2" color="text.secondary" align="center">
              Your Verified Employee credential has been added to Microsoft Authenticator.
            </Typography>
            <Alert severity="success" variant="outlined" sx={{ width: '100%' }}>
              You can now use this credential for passwordless sign-in across all connected apps.
            </Alert>
          </Box>
        </Zoom>
      )}

      {/* Failed */}
      {flowState === 'failed' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
          <Alert severity="error" sx={{ width: '100%' }}>
            {errorMsg || 'Credential issuance failed. Please try again.'}
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
            The credential offer has expired after 10 minutes.
          </Alert>
          <Button variant="outlined" startIcon={<ReplayIcon />} onClick={start}>
            Generate New Offer
          </Button>
        </Box>
      )}
    </FlowCard>
  );
}
