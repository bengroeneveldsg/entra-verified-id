import React, { useState } from 'react';
import {
  TextField,
  Button,
  Alert,
  CircularProgress,
  InputAdornment,
  IconButton,
  Box,
  Collapse,
} from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { FlowCard } from '@entra-vid/shared-ui';
import { authApi } from '../api';

interface LoginProps {
  onSuccess: () => void;
}

export default function Login({ onSuccess }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await authApi.login({
        username,
        password,
        totp_code: needsMfa ? totpCode : undefined,
      });

      if (result.mfa_required) {
        setNeedsMfa(true);
        setLoading(false);
        return;
      }

      onSuccess();
    } catch (err: any) {
      const msg =
        err?.response?.data?.detail ||
        err?.message ||
        'Login failed. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <FlowCard
      title="Admin Console"
      subtitle="Sign in to manage your Entra Verified ID deployment"
      initials="VID"
    >
      <Box component="form" onSubmit={handleSubmit} sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {error && <Alert severity="error" sx={{ borderRadius: 2 }}>{error}</Alert>}

        <TextField
          label="Username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          fullWidth
          disabled={loading || needsMfa}
        />

        <TextField
          label="Password"
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          fullWidth
          disabled={loading || needsMfa}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  onClick={() => setShowPassword((v) => !v)}
                  edge="end"
                  aria-label="toggle password visibility"
                >
                  {showPassword ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              </InputAdornment>
            ),
          }}
        />

        <Collapse in={needsMfa}>
          <TextField
            label="Authenticator Code"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            fullWidth
            helperText="Enter the 6-digit code from your authenticator app"
          />
        </Collapse>

        <Button
          type="submit"
          variant="contained"
          fullWidth
          size="large"
          disabled={loading}
          sx={{ mt: 1 }}
        >
          {loading ? <CircularProgress size={22} color="inherit" /> : needsMfa ? 'Verify' : 'Sign In'}
        </Button>

        {needsMfa && (
          <Button
            variant="text"
            size="small"
            onClick={() => { setNeedsMfa(false); setTotpCode(''); setError(null); }}
          >
            Back to login
          </Button>
        )}
      </Box>
    </FlowCard>
  );
}
