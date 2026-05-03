import { Stack, Typography } from '@mui/material';
import { ErrorOutline, CheckCircleOutline } from '@mui/icons-material';
import type { ToolStep } from '../api';
import { formatDuration } from '../lib/toolStepFormatting';

export default function ToolStepTrailing({ step }: { step: ToolStep }) {
  const out = step.output;
  if (!out) {
    return (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontSize: '0.65rem', opacity: 0.6 }}
      >
        pending
      </Typography>
    );
  }

  const duration = formatDuration(out.durationMs);
  const errored = out.isError || (typeof out.exitCode === 'number' && out.exitCode !== 0);

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      {errored ? (
        <ErrorOutline sx={{ fontSize: 13, color: 'error.main' }} />
      ) : (
        <CheckCircleOutline sx={{ fontSize: 13, color: 'success.main', opacity: 0.7 }} />
      )}
      {duration && (
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
          {duration}
        </Typography>
      )}
      {typeof out.exitCode === 'number' && out.exitCode !== 0 && (
        <Typography variant="caption" color="error.main" sx={{ fontSize: '0.65rem' }}>
          exit {out.exitCode}
        </Typography>
      )}
    </Stack>
  );
}
