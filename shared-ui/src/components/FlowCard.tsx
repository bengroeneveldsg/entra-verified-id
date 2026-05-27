import React from 'react';
import {
  Box,
  Typography,
  Divider,
  IconButton,
  Tooltip,
  SxProps,
  Theme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';

// ---------------------------------------------------------------------------
// FlowCard
//
// Full-page centred layout card for public authentication flows.
// Provides slots for a logo, title/subtitle, main content, and a footer.
// ---------------------------------------------------------------------------

export interface FlowCardProps {
  /** URL for the brand logo image. When omitted, branded initials are shown. */
  logoSrc?: string;
  /** Alt text for the logo image (ignored when logoSrc is not set). */
  logoAlt?: string;
  /** Branded initials shown when no logoSrc is provided. Defaults to "VID". */
  initials?: string;
  /** Card heading. */
  title: string;
  /** Optional subtitle / instruction text rendered below the title. */
  subtitle?: string;
  /** Primary card content. */
  children: React.ReactNode;
  /** Optional footer content, rendered below a divider. */
  footer?: React.ReactNode;
  /** Additional sx overrides on the outermost page container. */
  sx?: SxProps<Theme>;
  /** Called when the user presses the close button. When provided, a round X button appears in the top-right corner of the card. */
  onClose?: () => void;
}

export function FlowCard({
  logoSrc,
  logoAlt = 'Brand logo',
  initials = 'VID',
  title,
  subtitle,
  children,
  footer,
  sx,
  onClose,
}: FlowCardProps) {
  return (
    // Full-viewport centring wrapper
    <Box
      sx={[
        {
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 2,
          py: 4,
          background: (theme) =>
            theme.palette.mode === 'dark'
              ? `radial-gradient(ellipse at 50% 0%, ${alpha(theme.palette.primary.dark, 0.30)} 0%, ${theme.palette.background.default} 65%)`
              : `radial-gradient(ellipse at 50% 0%, ${alpha(theme.palette.primary.light, 0.15)} 0%, ${theme.palette.background.default} 65%)`,
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {/* Card surface */}
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          maxWidth: 480,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0,
          // Glass-morphism card
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          backgroundColor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.background.paper, 0.80)
              : alpha('#ffffff', 0.90),
          border: (theme) =>
            `1px solid ${
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.primary.main, 0.20)
                : alpha(theme.palette.primary.main, 0.12)
            }`,
          boxShadow: (theme) =>
            theme.palette.mode === 'dark'
              ? `0 16px 48px ${alpha('#000000', 0.55)}`
              : `0 8px 40px ${alpha(theme.palette.primary.dark, 0.12)}`,
          borderRadius: '20px',
          overflow: 'hidden',
        }}
      >
        {/* Close button */}
        {onClose && (
          <Tooltip title="Close">
            <IconButton
              aria-label="Close"
              onClick={onClose}
              size="small"
              sx={{
                position: 'absolute',
                top: 12,
                right: 12,
                zIndex: 1,
                color: 'text.secondary',
                backgroundColor: (theme) =>
                  theme.palette.mode === 'dark'
                    ? alpha(theme.palette.background.paper, 0.6)
                    : alpha('#ffffff', 0.6),
                backdropFilter: 'blur(8px)',
                border: (theme) => `1px solid ${alpha(theme.palette.divider, 0.5)}`,
                '&:hover': {
                  backgroundColor: (theme) =>
                    theme.palette.mode === 'dark'
                      ? alpha(theme.palette.background.paper, 0.85)
                      : alpha('#ffffff', 0.95),
                  color: 'text.primary',
                },
              }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Header: logo + title + subtitle                                  */}
        {/* ---------------------------------------------------------------- */}
        <Box
          sx={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            px: 4,
            pt: 4,
            pb: 3,
            gap: 1.5,
          }}
        >
          {/* Logo */}
          {logoSrc ? (
            <Box
              component="img"
              src={logoSrc}
              alt={logoAlt}
              sx={{ height: 52, width: 'auto', objectFit: 'contain' }}
            />
          ) : (
            <Box
              aria-hidden="true"
              sx={{
                width: 52,
                height: 52,
                borderRadius: '14px',
                background: (theme) =>
                  `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.secondary.main} 100%)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: (theme) =>
                  `0 4px 14px ${alpha(theme.palette.primary.main, 0.40)}`,
              }}
            >
              <Typography
                variant="subtitle1"
                sx={{
                  color: '#fff',
                  fontWeight: 800,
                  fontSize: '0.95rem',
                  letterSpacing: '0.05em',
                  lineHeight: 1,
                  userSelect: 'none',
                }}
              >
                {initials}
              </Typography>
            </Box>
          )}

          {/* Title */}
          <Typography
            variant="h5"
            component="h1"
            align="center"
            sx={{ fontWeight: 700, mt: 0.5 }}
          >
            {title}
          </Typography>

          {/* Subtitle */}
          {subtitle && (
            <Typography
              variant="body2"
              align="center"
              color="text.secondary"
              sx={{ maxWidth: 360, lineHeight: 1.6 }}
            >
              {subtitle}
            </Typography>
          )}
        </Box>

        {/* ---------------------------------------------------------------- */}
        {/* Content slot                                                      */}
        {/* ---------------------------------------------------------------- */}
        <Box
          sx={{
            width: '100%',
            px: 4,
            pb: footer ? 3 : 4,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
          }}
        >
          {children}
        </Box>

        {/* ---------------------------------------------------------------- */}
        {/* Footer slot (optional)                                            */}
        {/* ---------------------------------------------------------------- */}
        {footer && (
          <>
            <Divider sx={{ width: '100%' }} />
            <Box
              sx={{
                width: '100%',
                px: 4,
                py: 2.5,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                backgroundColor: (theme) =>
                  theme.palette.mode === 'dark'
                    ? alpha(theme.palette.background.default, 0.40)
                    : alpha(theme.palette.primary.main, 0.03),
              }}
            >
              {footer}
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}

export default FlowCard;
