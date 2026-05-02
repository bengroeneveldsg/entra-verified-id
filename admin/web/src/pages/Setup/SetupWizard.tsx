import React, { useEffect, useState } from 'react';
import {
  Box,
  Stepper,
  Step,
  StepLabel,
  Typography,
  Paper,
  CircularProgress,
} from '@mui/material';
import { Security as SecurityIcon } from '@mui/icons-material';
import { setupApi, SetupStatus } from '../../api/setup';
import { Step1AdminUser } from './Step1AdminUser';
import { Step2Tenant } from './Step2Tenant';
import { Step3Did } from './Step3Did';
import { Step4Domain } from './Step4Domain';
import { Step5Keys } from './Step5Keys';
import { Step6Review } from './Step6Review';

const STEPS = [
  'Admin Account',
  'Entra Tenant',
  'DID Configuration',
  'Domain Settings',
  'Signing Keys',
  'Review & Activate',
];

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setupApi.getStatus().then((s) => {
      setStatus(s);
      setActiveStep(s.current_step);
      setLoading(false);
    });
  }, []);

  const handleNext = () => {
    setActiveStep((prev) => prev + 1);
    // Refresh status
    setupApi.getStatus().then(setStatus);
  };

  if (loading || !status) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        backgroundColor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        py: 4,
        px: 2,
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 4 }}>
        <SecurityIcon color="primary" sx={{ fontSize: 36 }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Entra Verified ID Setup
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Complete all steps to activate your deployment
          </Typography>
        </Box>
      </Box>

      <Box sx={{ width: '100%', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {/* Stepper */}
        <Paper
          elevation={0}
          sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}
        >
          <Stepper
            activeStep={activeStep}
            sx={{
              display: { xs: 'none', md: 'flex' },
            }}
          >
            {STEPS.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>

          {/* Mobile: show current step only */}
          <Box sx={{ display: { xs: 'flex', md: 'none' }, alignItems: 'center', gap: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Step {activeStep + 1} of {STEPS.length}
            </Typography>
            <Typography variant="subtitle1" fontWeight={600}>
              {STEPS[activeStep]}
            </Typography>
          </Box>
        </Paper>

        {/* Step content */}
        <Paper
          elevation={0}
          sx={{ p: { xs: 2, md: 4 }, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}
        >
          {activeStep === 0 && (
            <Step1AdminUser
              hasBootstrapSecret={status.has_bootstrap_secret}
              onNext={handleNext}
            />
          )}
          {activeStep === 1 && <Step2Tenant onNext={handleNext} />}
          {activeStep === 2 && <Step3Did onNext={handleNext} />}
          {activeStep === 3 && <Step4Domain onNext={handleNext} />}
          {activeStep === 4 && <Step5Keys onNext={handleNext} />}
          {activeStep === 5 && <Step6Review onComplete={onComplete} />}
        </Paper>
      </Box>
    </Box>
  );
}
