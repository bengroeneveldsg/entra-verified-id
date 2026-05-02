/**
 * Shared DataGrid sx styles — "Refined Data Intelligence" design system.
 *
 * Spread `dataGridSx` into any DataGrid's `sx` prop for consistent, professional
 * table styling across the admin console.
 *
 * Static values are used throughout to satisfy the MUI v5 / DataGrid v7
 * strict nested-selector type constraints; theme tokens are resolved against
 * the light-mode palette used by this application.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const dataGridSx: Record<string, any> = {
  // ── Container ──────────────────────────────────────────────────────────────
  border: 'none',
  borderRadius: 0,
  fontSize: 13,
  fontFamily: 'inherit',

  // ── Column headers ─────────────────────────────────────────────────────────
  '& .MuiDataGrid-columnHeaders': {
    backgroundColor: '#F5F7FA',
    borderBottom: '2px solid rgba(0,0,0,0.10)',
    minHeight: '38px !important',
    maxHeight: '38px !important',
    lineHeight: '38px !important',
  },
  '& .MuiDataGrid-columnHeader': {
    height: '38px !important',
    paddingLeft: '12px',
    paddingRight: '12px',
  },
  '& .MuiDataGrid-columnHeaderTitle': {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'rgba(0,0,0,0.50)',
  },
  // Remove header separator lines
  '& .MuiDataGrid-columnSeparator': {
    display: 'none',
  },

  // ── Rows ───────────────────────────────────────────────────────────────────
  '& .MuiDataGrid-row': {
    position: 'relative',
    // Left-accent bar drawn via inset box-shadow — no layout shift
    transition: 'background-color 0.12s ease, box-shadow 0.12s ease',
  },
  '& .MuiDataGrid-row:hover': {
    backgroundColor: 'rgba(21, 101, 192, 0.04)',
    boxShadow: 'inset 3px 0 0 0 #1565C0',
  },
  '& .MuiDataGrid-row:hover .actions-cell': {
    opacity: 1,
  },
  '& .MuiDataGrid-row.Mui-selected': {
    backgroundColor: 'rgba(21, 101, 192, 0.08)',
    boxShadow: 'inset 3px 0 0 0 #1565C0',
  },
  '& .MuiDataGrid-row.Mui-selected:hover': {
    backgroundColor: 'rgba(21, 101, 192, 0.12)',
  },
  // Compact row height override
  '& .MuiDataGrid-row--densityCompact': {
    minHeight: '36px !important',
    maxHeight: '36px !important',
  },

  // ── Cells ──────────────────────────────────────────────────────────────────
  '& .MuiDataGrid-cell': {
    paddingLeft: '12px',
    paddingRight: '12px',
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    display: 'flex',
    alignItems: 'center',
    // Replace the default blue focus ring with a subtle bottom border
    outline: 'none !important',
  },
  '& .MuiDataGrid-cell:focus': {
    outline: 'none',
    borderBottom: '1px solid #1565C0',
  },
  '& .MuiDataGrid-cell:focus-within': {
    outline: 'none',
    borderBottom: '1px solid #1565C0',
  },
  '& .MuiDataGrid-columnHeader:focus': {
    outline: 'none',
  },
  '& .MuiDataGrid-columnHeader:focus-within': {
    outline: 'none',
  },

  // ── Actions cell (hidden until row hover) ─────────────────────────────────
  '& .actions-cell': {
    opacity: 0,
    transition: 'opacity 0.15s ease',
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  },

  // ── Footer / pagination ────────────────────────────────────────────────────
  '& .MuiDataGrid-footerContainer': {
    borderTop: '1px solid rgba(0,0,0,0.10)',
    minHeight: 44,
  },
  '& .MuiTablePagination-root': {
    fontSize: 12,
  },

  // ── Empty state ────────────────────────────────────────────────────────────
  '& .MuiDataGrid-overlay': {
    backgroundColor: 'transparent',
  },

  // ── Scrollbars (WebKit / Blink) ────────────────────────────────────────────
  '& ::-webkit-scrollbar': {
    width: 6,
    height: 6,
  },
  '& ::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '& ::-webkit-scrollbar-thumb': {
    background: 'rgba(0,0,0,0.18)',
    borderRadius: 3,
  },
  '& ::-webkit-scrollbar-thumb:hover': {
    background: 'rgba(0,0,0,0.30)',
  },

  // ── Remove virtual scroller focus outline ─────────────────────────────────
  '& .MuiDataGrid-virtualScroller:focus': {
    outline: 'none',
  },
};

// ── Shared cell helpers ──────────────────────────────────────────────────────

/** sx for monospace data cells (IDs, ARNs, URLs, timestamps). */
export const monoSx = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  fontSize: 12,
  letterSpacing: '-0.01em',
} as const;

/**
 * Colour palette for status dot indicators.
 * Keys cover session statuses, enabled/disabled, and log levels.
 */
export const STATUS_DOT_COLORS: Record<
  string,
  { dot: string; text: string; bg: string }
> = {
  // Session statuses
  pending:         { dot: '#F59E0B', text: '#92400E', bg: 'rgba(245,158,11,0.10)' },
  request_created: { dot: '#3B82F6', text: '#1E3A5F', bg: 'rgba(59,130,246,0.10)' },
  verified:        { dot: '#10B981', text: '#065F46', bg: 'rgba(16,185,129,0.10)' },
  failed:          { dot: '#EF4444', text: '#7F1D1D', bg: 'rgba(239,68,68,0.10)' },
  revoked:         { dot: '#9CA3AF', text: '#374151', bg: 'rgba(156,163,175,0.10)' },
  // App enabled state
  enabled:         { dot: '#10B981', text: '#065F46', bg: 'rgba(16,185,129,0.10)' },
  disabled:        { dot: '#9CA3AF', text: '#374151', bg: 'rgba(156,163,175,0.10)' },
  // Log levels
  ERROR:   { dot: '#EF4444', text: '#7F1D1D', bg: 'rgba(239,68,68,0.10)' },
  WARNING: { dot: '#F59E0B', text: '#92400E', bg: 'rgba(245,158,11,0.10)' },
  INFO:    { dot: '#3B82F6', text: '#1E3A5F', bg: 'rgba(59,130,246,0.10)' },
  DEBUG:   { dot: '#8B5CF6', text: '#4C1D95', bg: 'rgba(139,92,246,0.10)' },
};
