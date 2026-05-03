import { Box, Tooltip } from '@mui/material';
import { useGetGatewayStatusQuery } from '../api';

const POLL_MS = 5_000;

const COPY: Record<string, { color: string; tooltip: string }> = {
  connected: {
    color: 'success.main',
    tooltip: 'Gateway connected',
  },
  connecting: {
    color: 'warning.main',
    tooltip: 'Connecting to gateway…',
  },
  disconnected: {
    color: 'error.main',
    tooltip:
      'Gateway disconnected — agent traffic is paused. Reconnect attempts are running in the background.',
  },
  unpaired: {
    color: 'error.main',
    tooltip: 'Device not paired with the gateway. Run the pairing flow before sending messages.',
  },
};

export default function GatewayStatusDot({ size = 5 }: { size?: number }) {
  const { data } = useGetGatewayStatusQuery(undefined, {
    pollingInterval: POLL_MS,
    refetchOnMountOrArgChange: true,
  });

  const key = data?.hasCredentials === false ? 'unpaired' : (data?.state ?? 'disconnected');
  const meta = COPY[key];

  return (
    <Tooltip title={meta.tooltip} arrow placement="top">
      <Box
        aria-label={meta.tooltip}
        sx={{
          width: size,
          height: size,
          borderRadius: '50%',
          bgcolor: meta.color,
          flexShrink: 0,
          /* Pulse while connecting so the user sees something is in
           * progress and the UI isn't just frozen on a stale state. */
          animation:
            data?.state === 'connecting' ? 'gatewayPulse 1.4s ease-in-out infinite' : 'none',
          '@keyframes gatewayPulse': {
            '0%, 100%': { opacity: 1 },
            '50%': { opacity: 0.35 },
          },
        }}
      />
    </Tooltip>
  );
}
