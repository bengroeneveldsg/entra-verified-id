import React from 'react';
import { Card, CardContent, SxProps, Theme } from '@mui/material';
import { alpha } from '@mui/material/styles';

// ---------------------------------------------------------------------------
// BrandedCard
//
// A glass-morphism styled MUI Card intended for centred, single-focus content
// such as login flows, QR display, and status screens.
// ---------------------------------------------------------------------------

export interface BrandedCardProps {
  children: React.ReactNode;
  /** Maximum width of the card in pixels. Defaults to 480. */
  maxWidth?: number;
  /** Additional MUI sx overrides applied to the root Card element. */
  sx?: SxProps<Theme>;
}

export function BrandedCard({ children, maxWidth = 480, sx }: BrandedCardProps) {
  return (
    <Card
      elevation={0}
      sx={[
        (theme) => ({
          width: '100%',
          maxWidth,
          mx: 'auto',
          // Glass-morphism surface
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          backgroundColor:
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.background.paper, 0.75)
              : alpha('#ffffff', 0.85),
          border: `1px solid ${
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.primary.main, 0.18)
              : alpha(theme.palette.primary.main, 0.10)
          }`,
          boxShadow:
            theme.palette.mode === 'dark'
              ? `0 8px 32px ${alpha('#000000', 0.45)}, 0 1px 0 ${alpha(theme.palette.primary.light, 0.08)} inset`
              : `0 8px 32px ${alpha(theme.palette.primary.dark, 0.10)}, 0 1px 0 ${alpha('#ffffff', 0.90)} inset`,
          borderRadius: '16px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }),
        // Spread caller-supplied sx last so it can override anything above
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <CardContent
        sx={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          p: 4,
          '&:last-child': { pb: 4 },
        }}
      >
        {children}
      </CardContent>
    </Card>
  );
}

export default BrandedCard;
