import { useState, useCallback } from 'react';
import { authApi } from '../api';

interface AuthState {
  username: string | null;
  isAuthenticated: boolean;
}

const _state: AuthState = { username: null, isAuthenticated: false };

export function useAuth() {
  const [state, setState] = useState<AuthState>(_state);

  const login = useCallback(
    async (username: string, password: string, totpCode?: string) => {
      const result = await authApi.login({
        username,
        password,
        totp_code: totpCode,
      });
      if (result.mfa_required) {
        return { mfa_required: true };
      }
      _state.username = result.username;
      _state.isAuthenticated = true;
      setState({ username: result.username, isAuthenticated: true });
      return result;
    },
    [],
  );

  const logout = useCallback(async () => {
    await authApi.logout();
    _state.username = null;
    _state.isAuthenticated = false;
    setState({ username: null, isAuthenticated: false });
    window.location.href = '/login';
  }, []);

  return { ...state, login, logout };
}
