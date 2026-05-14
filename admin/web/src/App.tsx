import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { CircularProgress, Box } from '@mui/material';

import { setupApi } from './api/setup';
import Login from './pages/Login';
import { SetupWizard } from './pages/Setup/SetupWizard';
import { AppShell } from './components/AppShell';
import Dashboard from './pages/Dashboard';
import { SamlAppList } from './pages/SamlApps/List';
import { SamlAppEdit } from './pages/SamlApps/Edit';
import { SamlAppDetail } from './pages/SamlApps/Detail';
import Sessions from './pages/Sessions';
import Keys from './pages/Keys';
import Config from './pages/Config';
import Audit from './pages/Audit';

type AppState = 'loading' | 'setup' | 'login' | 'authenticated';

export default function App() {
  const [appState, setAppState] = useState<AppState>('loading');

  useEffect(() => {
    // Check setup status on every navigation to the root or protected routes
    setupApi.getStatus()
      .then((status) => {
        if (!status.onboarding_complete) {
          setAppState('setup');
        } else {
          // Light auth probe: GET /keys requires current_user dependency
          import('./api/client').then(({ apiClient }) => {
            apiClient.get('/keys/')
              .then(() => setAppState('authenticated'))
              .catch((err) => {
                setAppState(err.response?.status === 401 ? 'login' : 'login');
              });
          });
        }
      })
      .catch(() => setAppState('login'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (appState === 'loading') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (appState === 'setup') {
    return (
      <Routes>
        <Route path="/setup" element={<SetupWizard onComplete={() => setAppState('login')} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (appState === 'login') {
    return (
      <Routes>
        <Route path="/login" element={<Login onSuccess={() => setAppState('authenticated')} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Authenticated layout
  return (
    <Routes>
      <Route path="/" element={<AppShell onLogout={() => setAppState('login')} />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="saml-apps" element={<SamlAppList />} />
        <Route path="saml-apps/new" element={<SamlAppEdit />} />
        <Route path="saml-apps/:appId" element={<SamlAppDetail />} />
        <Route path="saml-apps/:appId/edit" element={<SamlAppEdit />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="keys" element={<Keys />} />
        <Route path="config" element={<Config />} />
        <Route path="audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
