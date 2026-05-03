import { useState, memo, useCallback } from 'react';
import { Box, Paper, Stack, Tooltip, Typography, IconButton, useTheme } from '@mui/material';
import { DeleteOutline, ContentCopy, Done, ErrorOutline } from '@mui/icons-material';
import { DeleteButton, MarkdownContent } from '../../../shared/ui';
import ThinkingBlock from './ThinkingBlock';
import ToolStepsBlock from './ToolStepsBlock';
import FileAttachments from './FileAttachments';
import CronMessageBubble from './CronMessageBubble';
import ChannelMetadataHeader from './ChannelMetadataHeader';
import { parseCronMessage } from '../lib/parseCronMessage';
import { parseChannelMetadata } from '../lib/parseChannelMetadata';
import { useDeleteMessageMutation, type Message, type MessageFile, type ToolStep } from '../api';

export type MessageLike =
  | Message
  | {
      text: string;
      role: string;
      thinking?: string | null;
      files?: MessageFile[];
      toolSteps?: ToolStep[] | null;
    };

interface MessageBubbleProps {
  message: MessageLike;
  isStreaming?: boolean;
  thinkingText?: string;
  messageId?: string;
  deliveryError?: string | null;
}

const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming,
  thinkingText,
  messageId,
  deliveryError,
}: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const theme = useTheme();
  const [deleteMessage] = useDeleteMessageMutation();

  const isUser = message.role === 'user';
  const thinking = thinkingText || ('thinking' in message ? message.thinking : null);
  const files = ('files' in message ? message.files : undefined) ?? [];
  const toolSteps =
    !isUser && 'toolSteps' in message && Array.isArray(message.toolSteps)
      ? (message.toolSteps as ToolStep[])
      : [];
  const parsedCron = isUser && !isStreaming ? parseCronMessage(message.text) : null;
  const parsedChannel =
    isUser && !isStreaming && !parsedCron ? parseChannelMetadata(message.text) : null;
  const displayText = parsedChannel?.cleanText ?? message.text ?? '';
  const hasTextContent = displayText && !displayText.startsWith('[Attached ');

  const handleCopy = () => {
    navigator.clipboard.writeText(displayText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDelete = useCallback(() => {
    if (messageId && 'conversationId' in message) {
      deleteMessage({ id: messageId, conversationId: message.conversationId });
    }
  }, [messageId, message, deleteMessage]);

  if (parsedCron) {
    return (
      <CronMessageBubble
        message={message as Message}
        messageId={messageId}
        parsed={parsedCron}
        deliveryError={deliveryError}
      />
    );
  }

  if (!isUser && !hasTextContent && !thinking && toolSteps.length > 0 && !isStreaming) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          mb: 1.5,
          width: '100%',
          maxWidth: { xs: '90%', sm: '80%', md: 'min(70%, 100%)' },
        }}
      >
        <ToolStepsBlock steps={toolSteps} asStandalone />
        {'createdAt' in message && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ opacity: 0.6, mt: 0.5, fontSize: '0.65rem' }}
          >
            {new Date((message as Message).createdAt).toLocaleTimeString()}
          </Typography>
        )}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        mb: 1.5,
        width: '100%',
        minWidth: 0,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Paper
        elevation={0}
        sx={{
          px: 2,
          py: 1,
          minWidth: 0,
          maxWidth: { xs: '90%', sm: '80%', md: 'min(70%, 100%)' },
          position: 'relative',
          bgcolor: isUser ? theme.palette.chat.userBubble : theme.palette.chat.assistantBubble,
          color: isUser ? theme.palette.chat.userText : 'text.primary',
          borderRadius: 3,
          borderTopRightRadius: isUser ? 4 : undefined,
          borderTopLeftRadius: isUser ? undefined : 4,
        }}
      >
        {hovered && (
          <Box sx={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 0.25 }}>
            <IconButton
              size="small"
              onClick={handleCopy}
              sx={{ opacity: 0.5, '&:hover': { opacity: 1 }, p: 0.3 }}
            >
              {copied ? (
                <Done sx={{ fontSize: 13, color: 'success.main' }} />
              ) : (
                <ContentCopy sx={{ fontSize: 13 }} />
              )}
            </IconButton>
            {messageId && 'conversationId' in message && (
              <DeleteButton
                onConfirm={handleDelete}
                message="Delete this message?"
                renderTrigger={(onClick) => (
                  <IconButton
                    size="small"
                    onClick={onClick}
                    sx={{ opacity: 0.5, '&:hover': { opacity: 1, color: 'error.main' }, p: 0.3 }}
                  >
                    <DeleteOutline sx={{ fontSize: 14 }} />
                  </IconButton>
                )}
              />
            )}
          </Box>
        )}
        {!isUser && thinking && (
          <ThinkingBlock text={thinking} isStreaming={isStreaming && !message.text} />
        )}
        {parsedChannel && (parsedChannel.sender || parsedChannel.conversation) && (
          <ChannelMetadataHeader
            sender={parsedChannel.sender}
            conversation={parsedChannel.conversation}
          />
        )}
        {files.length > 0 && <FileAttachments files={files} isUser={isUser} />}
        {hasTextContent &&
          (isUser ? (
            <MarkdownContent inheritColor>{displayText}</MarkdownContent>
          ) : (
            <MarkdownContent isStreaming={isStreaming}>{displayText}</MarkdownContent>
          ))}
        {!isUser && toolSteps.length > 0 && <ToolStepsBlock steps={toolSteps} />}
        {isStreaming && !hasTextContent && (
          <Box
            component="span"
            sx={{
              display: 'inline-block',
              width: 6,
              height: 16,
              bgcolor: 'text.secondary',
              animation: 'blink 1s step-end infinite',
              '@keyframes blink': { '50%': { opacity: 0 } },
            }}
          />
        )}
        {('createdAt' in message || deliveryError) && (
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            justifyContent={isUser ? 'flex-end' : 'flex-start'}
            sx={{ mt: 0.25 }}
          >
            {deliveryError && (
              <Tooltip title={deliveryError} arrow placement={isUser ? 'left' : 'right'}>
                <ErrorOutline
                  sx={{
                    fontSize: 14,
                    color: 'warning.main',
                    cursor: 'help',
                  }}
                />
              </Tooltip>
            )}
            {'createdAt' in message && (
              <Typography variant="caption" sx={{ opacity: 0.7 }}>
                {new Date(message.createdAt).toLocaleTimeString()}
              </Typography>
            )}
          </Stack>
        )}
      </Paper>
    </Box>
  );
});

export default MessageBubble;
