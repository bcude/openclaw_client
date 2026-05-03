import { Box, Chip, Typography } from '@mui/material';
import { ExpandMore } from '@mui/icons-material';
import type { ReactNode } from 'react';

interface ToolStepHeaderProps {
  expanded: boolean;
  onToggle: () => void;
  label: string;
  toolName: string;
  summary?: string;
  trailing?: ReactNode;
}

export default function ToolStepHeader({
  expanded,
  onToggle,
  label,
  toolName,
  summary,
  trailing,
}: ToolStepHeaderProps) {
  return (
    <Box
      onClick={onToggle}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        cursor: 'pointer',
        opacity: 0.7,
        '&:hover': { opacity: 1 },
        minWidth: 0,
      }}
    >
      <ExpandMore
        sx={{
          fontSize: 14,
          transition: 'transform 0.2s',
          transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          flexShrink: 0,
        }}
      />
      <Typography variant="caption" sx={{ fontWeight: 600, fontSize: '0.7rem', flexShrink: 0 }}>
        {label}
      </Typography>
      <Chip
        label={toolName}
        size="small"
        variant="outlined"
        sx={{
          height: 16,
          fontSize: '0.62rem',
          fontFamily: 'monospace',
          '& .MuiChip-label': { px: 0.5 },
          flexShrink: 0,
        }}
      />
      {summary && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            fontSize: '0.7rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.8,
            minWidth: 0,
            flex: 1,
          }}
        >
          {summary}
        </Typography>
      )}
      {trailing && <Box sx={{ flexShrink: 0, ml: 'auto' }}>{trailing}</Box>}
    </Box>
  );
}
