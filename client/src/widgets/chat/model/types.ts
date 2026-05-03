import type { RefObject } from 'react';
import type { Message, MessageFile, SessionRunStatus } from '../../../entities/message';

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  isFetching: boolean;
  hasMore: boolean;
  loadMoreCursor: string | undefined;

  isStreaming: boolean;
  streamingText: string;
  streamingThinking: string;
  streamError: string | null;
  pendingUserText: string;
  pendingFilesPreviews: MessageFile[];

  /** Last-run state from the gateway daemon. `null` while unknown. */
  runStatus: SessionRunStatus | null;
  /** Hide the timeout/abort banner for the current chat session. */

  send: (text: string, files: File[]) => Promise<void>;
  loadMore: () => void;
  handleScroll: () => void;
  clearError: () => void;

  scrollContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
}
