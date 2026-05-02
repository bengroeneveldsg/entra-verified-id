import { createTheme, Theme, alpha } from '@mui/material/styles';

// ---------------------------------------------------------------------------
// Brand colour tokens (also injected as CSS custom properties via CssBaseline
// globalStyles so non-MUI markup can reference them).
// ---------------------------------------------------------------------------
export const brandTokens = {
  primary: '#1565C0',
  primaryLight: '#5E92F3',
  primaryDark: '#003c8f',
  secondary: '#00897B',
  secondaryLight: '#4EBAAA',
  secondaryDark: '#005B4F',
} as const;

// ---------------------------------------------------------------------------
// Shared overrides applied to both themes
// ---------------------------------------------------------------------------
const sharedTypography = {
  fontFamily: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  h1: {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
  h2: {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontWeight: 700,
    letterSpacing: '-0.01em',
  },
  h3: {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontWeight: 600,
    letterSpacing: '-0.01em',
  },
  h4: {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontWeight: 600,
  },
  h5: {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontWeight: 600,
  },
  h6: {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontWeight: 600,
  },
  subtitle1: {
    fontWeight: 500,
  },
  subtitle2: {
    fontWeight: 500,
  },
  body1: {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  body2: {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  button: {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontWeight: 600,
    letterSpacing: '0.02em',
    textTransform: 'none' as const,
  },
} as const;

const sharedShape = {
  borderRadius: 8,
} as const;

// ---------------------------------------------------------------------------
// Light theme
// ---------------------------------------------------------------------------
export const lightTheme: Theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: brandTokens.primary,
      light: brandTokens.primaryLight,
      dark: brandTokens.primaryDark,
      contrastText: '#ffffff',
    },
    secondary: {
      main: brandTokens.secondary,
      light: brandTokens.secondaryLight,
      dark: brandTokens.secondaryDark,
      contrastText: '#ffffff',
    },
    error: {
      main: '#C62828',
      light: '#EF5350',
      dark: '#8E0000',
    },
    warning: {
      main: '#F57C00',
      light: '#FFB74D',
      dark: '#BF360C',
    },
    success: {
      main: '#2E7D32',
      light: '#66BB6A',
      dark: '#1B5E20',
    },
    background: {
      default: '#F4F6FA',
      paper: '#FFFFFF',
    },
    text: {
      primary: '#0D1B2A',
      secondary: '#4A5568',
    },
    divider: alpha('#1565C0', 0.12),
  },
  typography: sharedTypography,
  shape: sharedShape,
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':root': {
          '--brand-primary': brandTokens.primary,
          '--brand-primary-light': brandTokens.primaryLight,
          '--brand-primary-dark': brandTokens.primaryDark,
          '--brand-secondary': brandTokens.secondary,
          '--brand-secondary-light': brandTokens.secondaryLight,
          '--brand-secondary-dark': brandTokens.secondaryDark,
        },
        '*': {
          boxSizing: 'border-box',
        },
        body: {
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 24,
          paddingRight: 24,
        },
        containedPrimary: {
          boxShadow: `0 2px 8px ${alpha(brandTokens.primary, 0.35)}`,
          '&:hover': {
            boxShadow: `0 4px 16px ${alpha(brandTokens.primary, 0.45)}`,
          },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          boxShadow: '0 2px 12px rgba(13, 27, 42, 0.08)',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: 6,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
        size: 'small',
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        rounded: {
          borderRadius: 12,
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Dark theme
// ---------------------------------------------------------------------------
export const darkTheme: Theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#5E92F3',
      light: '#93C4FF',
      dark: brandTokens.primary,
      contrastText: '#0D1B2A',
    },
    secondary: {
      main: '#4EBAAA',
      light: '#82EDD9',
      dark: brandTokens.secondary,
      contrastText: '#0D1B2A',
    },
    error: {
      main: '#EF5350',
      light: '#FF8A80',
      dark: '#C62828',
    },
    warning: {
      main: '#FFB74D',
      light: '#FFD54F',
      dark: '#F57C00',
    },
    success: {
      main: '#66BB6A',
      light: '#A5D6A7',
      dark: '#2E7D32',
    },
    background: {
      default: '#0A1628',
      paper: '#0F2044',
    },
    text: {
      primary: '#E8EEF9',
      secondary: '#8EA3BE',
    },
    divider: alpha('#5E92F3', 0.15),
  },
  typography: sharedTypography,
  shape: sharedShape,
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':root': {
          '--brand-primary': '#5E92F3',
          '--brand-primary-light': '#93C4FF',
          '--brand-primary-dark': brandTokens.primary,
          '--brand-secondary': '#4EBAAA',
          '--brand-secondary-light': '#82EDD9',
          '--brand-secondary-dark': brandTokens.secondary,
        },
        '*': {
          boxSizing: 'border-box',
        },
        body: {
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 24,
          paddingRight: 24,
        },
        containedPrimary: {
          boxShadow: `0 2px 8px ${alpha('#5E92F3', 0.35)}`,
          '&:hover': {
            boxShadow: `0 4px 16px ${alpha('#5E92F3', 0.45)}`,
          },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          boxShadow: '0 2px 24px rgba(0, 0, 0, 0.4)',
          backgroundImage: 'none',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: 6,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
        size: 'small',
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        rounded: {
          borderRadius: 12,
        },
      },
    },
  },
});
