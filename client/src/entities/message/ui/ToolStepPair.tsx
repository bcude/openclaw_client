import { useMemo, useState } from 'react';
import { Box, Collapse, Typography } from '@mui/material';
import type { ToolStep } from '../api';
import { summarizeInput } from '../lib/toolStepFormatting';
import ToolStepCodeFrame from './ToolStepCodeFrame';
import ToolStepHeader from './ToolStepHeader';
import ToolStepTrailing from './ToolStepTrailing';

interface ToolStepPairProps {
  step: ToolStep;
  idx: number;
}

export default function ToolStepPair({ step, idx }: ToolStepPairProps) {
  const [callOpen, setCallOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);

  const inputJson = useMemo(() => {
    if (!step.input) return '';
    try {
      return JSON.stringify(step.input, null, 2);
    } catch {
      return String(step.input);
    }
  }, [step.input]);

  const summary = summarizeInput(step.name, step.input);
  const out = step.output;

  return (
    <Box sx={{ mt: idx === 0 ? 0 : 0.75 }}>
      <ToolStepHeader
        expanded={callOpen}
        onToggle={() => setCallOpen((v) => !v)}
        label="Tool call"
        toolName={step.name}
        summary={summary}
        trailing={<ToolStepTrailing step={step} />}
      />
      <Collapse in={callOpen}>
        {step.input ? (
          <ToolStepCodeFrame>{inputJson}</ToolStepCodeFrame>
        ) : (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', pl: 2.5, fontStyle: 'italic', opacity: 0.7 }}
          >
            (no arguments)
          </Typography>
        )}
      </Collapse>

      <Box sx={{ mt: 0.25 }}>
        <ToolStepHeader
          expanded={outputOpen}
          onToggle={() => setOutputOpen((v) => !v)}
          label="Tool output"
          toolName={step.name}
        />
        <Collapse in={outputOpen}>
          {out ? (
            <>
              {out.text ? (
                <ToolStepCodeFrame>{out.text}</ToolStepCodeFrame>
              ) : (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', pl: 2.5, fontStyle: 'italic', opacity: 0.7 }}
                >
                  (no output)
                </Typography>
              )}
              {out.truncated && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: 'block',
                    pl: 2.5,
                    mt: 0.25,
                    fontStyle: 'italic',
                    opacity: 0.7,
                  }}
                >
                  output truncated for storage
                </Typography>
              )}
            </>
          ) : (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', pl: 2.5, fontStyle: 'italic', opacity: 0.7 }}
            >
              {/* In-flight call (e.g. live stream) or aborted run — no result row exists yet. */}
              (no result captured)
            </Typography>
          )}
        </Collapse>
      </Box>
    </Box>
  );
}
