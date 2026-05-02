import type { ReactElement } from 'react';
import { Link, Outlet, useLocation, useSearchParams } from 'react-router';
import { Box, IconButton, Typography, CircularProgress, Tab, Tabs } from '@mui/material';
import { ArrowBack, Extension, FolderOpen, Group, Insights, Tune } from '@mui/icons-material';
import { useGetAgentQuery } from '../../../entities/agent';

interface WorkspaceProps {
  agentId: string;
}

type SectionId = 'workspace' | 'usage' | 'budgets' | 'skills' | 'subagents';

interface SectionDef {
  id: SectionId;
  label: string;
  icon: ReactElement;
  caption: string;
}

const SECTIONS: SectionDef[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    icon: <FolderOpen sx={{ fontSize: 18 }} />,
    caption: 'Workspace files',
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: <Insights sx={{ fontSize: 18 }} />,
    caption: 'Token usage and cost across this agent',
  },
  {
    id: 'budgets',
    label: 'Budgets',
    icon: <Tune sx={{ fontSize: 18 }} />,
    caption: 'Per-agent character budgets',
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: <Extension sx={{ fontSize: 18 }} />,
    caption: 'Per-agent skill allowlist',
  },
  {
    id: 'subagents',
    label: 'Subagents',
    icon: <Group sx={{ fontSize: 18 }} />,
    caption: 'Child-agent defaults',
  },
];

function activeSectionFromPath(pathname: string): SectionId {
  const last = pathname.split('/').filter(Boolean).pop() ?? '';
  return SECTIONS.some((s) => s.id === last) ? (last as SectionId) : 'workspace';
}

export default function Workspace({ agentId }: WorkspaceProps) {
  const [searchParams] = useSearchParams();
  const returnConv = searchParams.get('return');
  const { data: agent, isLoading } = useGetAgentQuery(agentId, { skip: !agentId });
  const { pathname } = useLocation();
  const section = activeSectionFromPath(pathname);

  const backHref = returnConv ? `/agent/${agentId}/chat/${returnConv}` : '/';
  const activeCaption = SECTIONS.find((s) => s.id === section)?.caption ?? '';

  const tabHref = (id: SectionId): string => {
    const base = `/agent/${agentId}/${id}`;
    return returnConv ? `${base}?return=${returnConv}` : base;
  };

  if (isLoading && !agent) {
    return (
      <Box
        sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}
      >
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: { xs: '100vh', md: 'calc(100vh - 48px)' },
        minWidth: 0,
        width: '100%',
        overflowX: 'hidden',
      }}
    >
      <Box
        sx={{
          px: { xs: 1.5, md: 2 },
          py: 1.5,
          pl: { xs: 7, md: 2 },
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minWidth: 0,
        }}
      >
        <IconButton
          component={Link}
          to={backHref}
          size="small"
          aria-label="Back"
          sx={{ flexShrink: 0 }}
        >
          <ArrowBack sx={{ fontSize: 22 }} />
        </IconButton>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="h6" fontWeight={600} noWrap>
            {agent?.name ?? 'Agent'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {activeCaption}
          </Typography>
        </Box>
      </Box>

      <Box
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
          px: { xs: 1, md: 2 },
        }}
      >
        <Tabs
          value={section}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{
            minHeight: 40,
            '& .MuiTab-root': {
              minHeight: 40,
              textTransform: 'none',
              fontWeight: 600,
              fontSize: '0.82rem',
              px: 1.5,
            },
          }}
        >
          {SECTIONS.map((s) => (
            <Tab
              key={s.id}
              value={s.id}
              component={Link}
              to={tabHref(s.id)}
              iconPosition="start"
              icon={s.icon}
              label={s.label}
            />
          ))}
        </Tabs>
      </Box>

      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: 'auto',
          px: { xs: 2, md: 3 },
          py: 2,
        }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}
