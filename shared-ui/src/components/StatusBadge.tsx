import React from 'react';
import { Chip, CircularProgress, keyframes } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ErrorIcon from '@mui/icons-material/Error';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import { alpha } from '@mui/material/styles';

// ---------------------------------------------------------------------------
// StatusBadge
//
// Compact status indicator chip. Pending state carries an animated pulse so
// users can see the app is waiting for a response without an explicit spinner.
// ---------------------------------------------------------------------------

export type StatusValue = 'pending' | 'success' | 'failed' | 'claimed' | 'error';

export interface StatusBadgeProps {
  status: StatusValue;
}

// Subtle background pulse for the pending state
const pulseAnimation = keyframes`
  0%   { opacity: 1; }
  50%  { opacity: 0.55; }
  100% { opacity: 1; }
`;

interface StatusConfig {
  label: string;
  color: 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning';
  icon: React.ReactElement;
  pulse: boolean;
}

const STATUS_CONFIG: Record<StatusValue, StatusConfig> = {
  pending: {
    label: 'Pending',
    color: 'warning',
    icon: <CircularProgress size={14} thickness={5} color="inherit" />,
    pulse: true,
  },
  success: {
    label: 'Success',
    color: 'success',
    icon: <CheckCircleIcon fontSize="small" />,
    pulse: false,
  },
  claimed: {
    label: 'Claimed',
    color: 'success',
    icon: <CheckCircleIcon fontSize="small" />,
    pulse: false,
  },
  failed: {
    label: 'Failed',
    color: 'error',
    icon: <CancelIcon fontSize="small" />,
    pulse: false,
  },
  error: {
    label: 'Error',
    color: 'error',
    icon: <ErrorIcon fontSize="small" />,
    pulse: false,
  },
};

// Fallback config for any unanticipated status value
const FALLBACK_CONFIG: StatusConfig = {
  label: 'Unknown',
  color: 'default',
  icon: <AccessTimeIcon fontSize="small" />,
  pulse: false,
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? FALLBACK_CONFIG;

  return (
    <Chip
      size="small"
      label={config.label}
      color={config.color}
      icon={config.icon}
      sx={[
        {
          fontWeight: 700,
          fontSize: '0.75rem',
          height: 26,
          letterSpacing: '0.03em',
          // Give the chip a lightly tinted background so it reads on both
          // light and dark surfaces
          '& .MuiChip-icon': {
            ml: '6px',
          },
        },
        config.pulse && {
          animation: `${pulseAnimation} 1.6s ease-in-out infinite`,
          // Slightly bolder background to make the pulse readable
          backgroundColor: (theme) =>
            alpha(theme.palette.warning.main, 0.18),
          color: (theme) => theme.palette.warning.dark,
          border: (theme) =>
            `1px solid ${alpha(theme.palette.warning.main, 0.40)}`,
        },
      ]}
    />
  );
}

export default StatusBadge;
