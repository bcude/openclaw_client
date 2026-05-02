import { useState, useEffect, useRef } from 'react';
import {
  Collapse,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  IconButton,
  useTheme,
} from '@mui/material';
import { Add, ExpandMore, ExpandLess, DeleteOutline } from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router';
import { useDeleteAgentMutation } from '../../../entities/agent';
import { useCreateConversationMutation, ConversationItem } from '../../../entities/conversation';
import { DeleteButton } from '../../../shared/ui';
import AgentSpendRing from './AgentSpendRing';

interface AgentSectionProps {
  agent: { _id: string; name: string; model?: string | null; openclawAgentId?: string };
  conversations: { _id: string; title: string | null; createdAt: string }[];
  searchQuery?: string;
  collapseKey?: number;
  onNavigate?: () => void;
  disabled?: boolean;
}

export default function AgentSection({
  agent,
  conversations,
  searchQuery,
  collapseKey,
  onNavigate,
  disabled,
}: AgentSectionProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const theme = useTheme();
  const { sidebar } = theme.palette;
  const isAgentActive = location.pathname.startsWith(`/agent/${agent._id}/`);
  const [expanded, setExpanded] = useState(isAgentActive);

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (collapseKey && !isAgentActive) setExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseKey]);
  const [hovered, setHovered] = useState(false);

  const [createConversation] = useCreateConversationMutation();
  const [deleteAgent] = useDeleteAgentMutation();
  const modelId = agent.model ?? null;

  const isSearchActive = Boolean(searchQuery);
  const agentNameMatches = searchQuery
    ? agent.name.toLowerCase().includes(searchQuery.toLowerCase())
    : true;

  if (isSearchActive && !agentNameMatches) {
    return null;
  }

  const handleNewChat = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await createConversation({ agentId: agent._id });
    if ('data' in result && result.data) {
      setExpanded(true);
      navigate(`/agent/${agent._id}/chat/${result.data._id}`);
      onNavigate?.();
    }
  };

  const handleDeleteAgent = async () => {
    await deleteAgent(agent._id);
    if (location.pathname.startsWith(`/agent/${agent._id}`)) {
      navigate('/');
    }
  };

  return (
    <>
      <ListItem
        disablePadding
        sx={{
          mb: 0.2,
          opacity: disabled ? 0.4 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
          transition: 'opacity 0.2s',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <ListItemButton
          onClick={() => setExpanded(!expanded)}
          sx={{
            borderRadius: 1.5,
            py: 0.6,
            px: 1.5,
            '&:hover': { bgcolor: sidebar.hover },
          }}
        >
          <ListItemIcon
            sx={{ minWidth: 34, color: isAgentActive ? sidebar.selectedBorder : sidebar.text }}
          >
            <AgentSpendRing
              agentId={agent._id}
              openclawAgentId={agent.openclawAgentId}
              model={modelId}
              size={26}
            />
          </ListItemIcon>
          <ListItemText
            primary={agent.name}
            sx={{
              '& .MuiListItemText-primary': {
                color: isAgentActive ? sidebar.selectedText : sidebar.text,
                fontSize: '0.78rem',
                fontWeight: isAgentActive ? 600 : 500,
                textTransform: 'capitalize',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }}
          />
          {hovered && (
            <DeleteButton
              onConfirm={handleDeleteAgent}
              message="Delete this agent and all its conversations?"
              renderTrigger={(onClick) => (
                <IconButton
                  size="small"
                  onClick={onClick}
                  sx={{
                    p: 0.2,
                    mr: 0.2,
                    color: sidebar.text,
                    opacity: 0.6,
                    '&:hover': { color: '#f44336', opacity: 1 },
                  }}
                >
                  <DeleteOutline sx={{ fontSize: 14 }} />
                </IconButton>
              )}
            />
          )}
          <IconButton
            size="small"
            onClick={handleNewChat}
            sx={{ color: sidebar.text, p: 0.3, mr: 0.3, '&:hover': { color: 'success.main' } }}
          >
            <Add sx={{ fontSize: 14 }} />
          </IconButton>
          {expanded ? (
            <ExpandLess sx={{ fontSize: 16, color: sidebar.text }} />
          ) : (
            <ExpandMore sx={{ fontSize: 16, color: sidebar.text }} />
          )}
        </ListItemButton>
      </ListItem>
      <Collapse in={isSearchActive ? true : expanded} timeout="auto" unmountOnExit>
        <List disablePadding>
          {conversations.length === 0 && !isSearchActive ? (
            <Typography
              sx={{
                pl: 5,
                py: 0.5,
                color: sidebar.text,
                fontSize: '0.7rem',
                fontStyle: 'italic',
                opacity: 0.7,
              }}
            >
              No chats yet
            </Typography>
          ) : (
            conversations.map((conv) => (
              <ConversationItem
                key={conv._id}
                agentId={agent._id}
                conversation={conv}
                onNavigate={onNavigate}
              />
            ))
          )}
        </List>
      </Collapse>
    </>
  );
}
