import { useMemo } from 'react';
import { Box, CircularProgress, Divider, Stack, Tooltip, Typography } from '@mui/material';
import { SmartToy } from '@mui/icons-material';
import {
  useGetAgentLimitsQuery,
  type AgentLimitWindow,
  type AgentLimitWindowState,
} from '../../../entities/agent';
import { ProviderLogo } from '../../../shared/ui';

interface AgentSpendRingProps {
  agentId: string;
  openclawAgentId?: string | null;
  model?: string | null;
  size?: number;
}

interface WindowRow {
  id: AgentLimitWindow;
  label: string;
  state: AgentLimitWindowState;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function ratioColour(state: AgentLimitWindowState): 'secondary' | 'warning' | 'error' | 'primary' {
  if (state.exceeded) return 'error';
  if (state.nearLimit) return 'warning';
  return state.limit == null ? 'primary' : 'secondary';
}

function pickHotWindow(rows: WindowRow[]): WindowRow {
  const configured = rows.filter((r) => r.state.limit != null);
  if (configured.length === 0) return rows[0];
  return configured.reduce((acc, r) => ((r.state.ratio ?? 0) > (acc.state.ratio ?? 0) ? r : acc));
}

function prettyProvider(provider: string): string {
  if (!provider) return '';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function splitModel(model: string | null | undefined): { provider: string; name: string } {
  if (!model) return { provider: '', name: '' };
  const slash = model.indexOf('/');
  if (slash <= 0) return { provider: '', name: model };
  return { provider: model.slice(0, slash), name: model.slice(slash + 1) };
}

export default function AgentSpendRing({
  agentId,
  openclawAgentId,
  model,
  size = 22,
}: AgentSpendRingProps) {
  const { data, isFetching } = useGetAgentLimitsQuery(agentId, {
    skip: !agentId,
    refetchOnMountOrArgChange: true,
  });

  const rows = useMemo<WindowRow[]>(() => {
    if (!data) return [];
    return [
      { id: 'daily', label: 'Daily', state: data.windows.daily },
      { id: 'monthly', label: 'Monthly', state: data.windows.monthly },
      { id: 'total', label: 'All-time', state: data.windows.total },
    ];
  }, [data]);

  const { provider, name: modelName } = splitModel(model);
  const innerLogoSize = Math.min(size - 8, 14);
  const ringThickness = Math.max(3, size / 9);

  const hot = rows.length > 0 ? pickHotWindow(rows) : null;
  const hasCap = hot?.state.limit != null;
  const colour = hot ? ratioColour(hot.state) : 'primary';
  const pct = !hot || hot.state.ratio == null ? 0 : Math.min(100, hot.state.ratio * 100);

  const popoverTitle = (
    <Box sx={{ minWidth: 220, py: 0.25, px: 0.5 }}>
      <Typography
        variant="caption"
        sx={{
          fontWeight: 700,
          display: 'block',
          mb: 0.75,
          color: 'text.primary',
          fontSize: '0.75rem',
        }}
      >
        Spend vs. cap
      </Typography>
      {rows.length === 0 ? (
        <Typography variant="caption" sx={{ fontSize: '0.72rem', color: 'text.secondary' }}>
          {isFetching ? 'Loading…' : 'No usage data yet.'}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {rows.map((r) => {
            const overLimit = r.state.exceeded;
            const nearLimit = r.state.nearLimit;
            const noCap = r.state.limit == null;
            return (
              <Box
                key={r.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1.5,
                }}
              >
                <Typography
                  variant="caption"
                  sx={{ fontSize: '0.72rem', color: 'text.secondary', fontWeight: 500 }}
                >
                  {r.label}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: '0.72rem',
                    fontWeight: overLimit || nearLimit ? 700 : 500,
                    color: overLimit
                      ? 'error.main'
                      : nearLimit
                        ? 'warning.main'
                        : noCap
                          ? 'text.secondary'
                          : 'text.primary',
                  }}
                >
                  {noCap
                    ? `${fmtUsd(r.state.spent)} / no cap`
                    : `${fmtUsd(r.state.spent)} / ${fmtUsd(r.state.limit ?? 0)} (${(
                        (r.state.ratio ?? 0) * 100
                      ).toFixed(0)}%)`}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      )}

      {(provider || modelName || openclawAgentId) && (
        <>
          <Divider sx={{ my: 0.75, opacity: 0.6 }} />
          <Stack spacing={0.25}>
            {(provider || modelName) && (
              <Typography
                variant="caption"
                sx={{
                  fontSize: '0.7rem',
                  color: 'text.secondary',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {provider ? prettyProvider(provider) : 'Model'}
                {modelName ? ` · ${modelName}` : ''}
              </Typography>
            )}
            {openclawAgentId && (
              <Typography
                variant="caption"
                sx={{
                  fontSize: '0.7rem',
                  color: 'text.disabled',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                agent · {openclawAgentId}
              </Typography>
            )}
          </Stack>
        </>
      )}
    </Box>
  );

  return (
    <Tooltip
      placement="bottom-start"
      arrow
      title={popoverTitle}
      slotProps={{
        tooltip: {
          sx: {
            bgcolor: 'background.paper',
            color: 'text.primary',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 2,
            boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
            px: 1.5,
            py: 1,
            maxWidth: 320,
          },
        },
        arrow: {
          sx: {
            color: 'background.paper',
            '&::before': { border: '1px solid', borderColor: 'divider' },
          },
        },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          width: size,
          height: size,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'default',
        }}
      >
        <CircularProgress
          variant="determinate"
          value={100}
          size={size}
          thickness={ringThickness}
          sx={{
            position: 'absolute',
            inset: 0,
            color: 'action.hover',
          }}
        />
        {hasCap && (
          <CircularProgress
            variant="determinate"
            value={pct}
            color={colour}
            size={size}
            thickness={ringThickness}
            sx={{
              position: 'absolute',
              inset: 0,
              transition: 'all 0.3s',
            }}
          />
        )}
        <Box
          sx={{
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: innerLogoSize,
            height: innerLogoSize,
          }}
        >
          <ProviderLogo
            modelId={model ?? null}
            size={innerLogoSize}
            fallback={<SmartToy sx={{ fontSize: innerLogoSize }} />}
          />
        </Box>
      </Box>
    </Tooltip>
  );
}
