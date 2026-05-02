import React from 'react';
import {
  Box,
  Link,
  Skeleton,
  Typography,
  SxProps,
  Theme,
} from '@mui/material';
import SmartphoneIcon from '@mui/icons-material/Smartphone';

// ---------------------------------------------------------------------------
// QrDisplay
//
// Shows a base64-encoded QR code image prominently, with a mobile deep-link
// below for users who are already on a phone. Renders a loading skeleton
// while the QR code string is empty.
// ---------------------------------------------------------------------------

export interface QrDisplayProps {
  /** Base64 PNG data URI or raw base64 string for the QR code image. */
  qrCode: string;
  /** Deep-link URL (e.g. openid-vc://...) opened when the user taps the link. */
  deepLink: string;
  /** Size in pixels for the QR image. Defaults to 240. */
  size?: number;
  /** Additional sx overrides for the root container. */
  sx?: SxProps<Theme>;
}

function toDataUri(qrCode: string): string {
  if (!qrCode) return '';
  // Accept either a full data URI or a raw base64 blob
  if (qrCode.startsWith('data:')) return qrCode;
  return `data:image/png;base64,${qrCode}`;
}

export function QrDisplay({ qrCode, deepLink, size = 240, sx }: QrDisplayProps) {
  const isLoading = !qrCode;
  const src = toDataUri(qrCode);

  return (
    <Box
      sx={[
        {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {/* QR code or loading skeleton */}
      {isLoading ? (
        <Skeleton
          variant="rectangular"
          width={size}
          height={size}
          sx={{ borderRadius: 2 }}
          animation="wave"
        />
      ) : (
        <Box
          component="img"
          src={src}
          alt="Scan this QR code with your authenticator"
          width={size}
          height={size}
          sx={{
            borderRadius: 2,
            border: (theme) => `1px solid ${theme.palette.divider}`,
            // White background so the QR scans correctly on dark surfaces
            backgroundColor: '#ffffff',
            p: 1,
            display: 'block',
          }}
        />
      )}

      {/* Mobile deep-link */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          opacity: isLoading ? 0.4 : 1,
          transition: 'opacity 0.2s',
        }}
      >
        <SmartphoneIcon
          fontSize="small"
          sx={{ color: 'text.secondary', flexShrink: 0 }}
        />
        <Typography variant="body2" color="text.secondary">
          {isLoading ? (
            <Skeleton width={180} />
          ) : (
            <Link
              href={deepLink}
              underline="hover"
              color="primary"
              sx={{ fontWeight: 500 }}
            >
              Or tap here on mobile
            </Link>
          )}
        </Typography>
      </Box>
    </Box>
  );
}

export default QrDisplay;
