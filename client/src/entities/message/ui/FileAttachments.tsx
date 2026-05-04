import { Box, Chip, Skeleton, useTheme } from '@mui/material';
import { InsertDriveFileOutlined } from '@mui/icons-material';
import { alpha } from '@mui/material/styles';
import { API_BASE_URL } from '../../../shared/api';
import { useAuthedBlobUrl } from '../../../shared/hooks';
import type { MessageFile } from '../api';

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveRawUrl(rawUrl: string): string {
  if (rawUrl.startsWith('blob:') || rawUrl.startsWith('http')) return rawUrl;
  return `${API_BASE_URL.replace('/api', '')}${rawUrl}`;
}

interface FileAttachmentProps {
  file: MessageFile;
  isUser: boolean;
}

/**
 * One attachment row. Lives as its own component so each file gets
 * its own `useAuthedBlobUrl` call (the hook can't run inside a `.map`)
 * and so the same blob URL is shared between the surrounding `<a>`
 * and the inline `<img>` — keeping "open in new tab" and "save image"
 * working off the same in-memory blob.
 */
function FileAttachment({ file, isUser }: FileAttachmentProps) {
  const theme = useTheme();
  const { userText } = theme.palette.chat;
  const isImage = file.mimetype.startsWith('image/');
  const rawUrl = resolveRawUrl(file.url);
  const resolved = useAuthedBlobUrl(rawUrl);

  if (isImage) {
    return (
      <Box
        component={resolved ? 'a' : 'div'}
        href={resolved || undefined}
        target={resolved ? '_blank' : undefined}
        rel="noopener"
        sx={{ display: 'block', maxWidth: 200, borderRadius: 1, overflow: 'hidden' }}
      >
        {resolved ? (
          <Box
            component="img"
            src={resolved}
            alt={file.originalName}
            sx={{
              width: '100%',
              height: 'auto',
              display: 'block',
              maxHeight: 160,
              objectFit: 'cover',
            }}
          />
        ) : (
          <Skeleton variant="rectangular" width={200} height={140} />
        )}
      </Box>
    );
  }

  return (
    <Chip
      component="a"
      href={resolved || undefined}
      target="_blank"
      rel="noopener"
      download={file.originalName}
      icon={<InsertDriveFileOutlined sx={{ fontSize: 14 }} />}
      label={`${file.originalName} (${formatFileSize(file.size)})`}
      size="small"
      clickable={Boolean(resolved)}
      disabled={!resolved}
      sx={{
        maxWidth: 220,
        bgcolor: isUser ? alpha(userText, 0.12) : 'background.paper',
        color: isUser ? userText : 'text.primary',
        fontSize: '0.72rem',
      }}
    />
  );
}

interface FileAttachmentsProps {
  files: MessageFile[];
  isUser: boolean;
}

export default function FileAttachments({ files, isUser }: FileAttachmentsProps) {
  if (!files?.length) return null;

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.8, mb: 0.5 }}>
      {files.map((f) => (
        <FileAttachment key={f.filename} file={f} isUser={isUser} />
      ))}
    </Box>
  );
}
