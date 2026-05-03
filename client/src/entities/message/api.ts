import { baseApi } from '../../shared/api/baseApi';

export interface MessageFile {
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  url: string;
}

/** Provider-reported result of a single tool invocation. */
export interface ToolStepOutput {
  text: string;
  isError: boolean;
  status?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  truncated?: boolean;
}

/**
 * One tool invocation captured from the assistant's JSONL turn — the
 * `toolCall` content part paired with its matching `toolResult` row. The
 * UI renders these as collapsible "Tool call / Tool output" blocks beneath
 * the thinking section so users can audit what the agent did.
 */
export interface ToolStep {
  id: string;
  name: string;
  input: Record<string, unknown> | null;
  output: ToolStepOutput | null;
}

export interface Message {
  _id: string;
  conversationId: string;
  text: string;
  thinking: string | null;
  toolSteps?: ToolStep[] | null;
  files: MessageFile[];
  role: 'user' | 'assistant';
  createdAt: string;
}

export interface MessagesResponse {
  total: number;
  items: Message[];
  hasMore: boolean;
}

export interface MessagesQueryArg {
  conversationId: string;
  before?: string;
}

/**
 * Run-state surfaced from `sessions.json` on each poll. When `aborted` is
 * true the OpenClaw daemon ended the last run abnormally (idle timeout,
 * error, manual cancel) and the agent's reply was streamed only — never
 * committed to the JSONL. The UI shows a banner explaining this so the
 * apparent gap doesn't look like a sync failure.
 */
export interface SessionRunStatus {
  aborted: boolean;
  status: string | null;
  reason: string | null;
  endedAt: number | null;
}

export interface PollResponse {
  items: Message[];
  synced: number;
  runStatus: SessionRunStatus | null;
}

export interface PollQueryArg {
  conversationId: string;
  after?: string;
}

export const messagesApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getMessages: build.query<MessagesResponse, MessagesQueryArg>({
      query: ({ conversationId, before }) => {
        const params = new URLSearchParams();
        if (before) params.set('before', before);
        const qs = params.toString();
        return `/message/conversation/${conversationId}${qs ? `?${qs}` : ''}`;
      },
      serializeQueryArgs: ({ queryArgs }) => queryArgs.conversationId,
      merge: (currentCache, newResponse, { arg }) => {
        if (arg.before) {
          const existingIds = new Set(currentCache.items.map((m) => m._id));
          const unique = newResponse.items.filter((m) => !existingIds.has(m._id));
          currentCache.items = [...unique, ...currentCache.items];
          currentCache.hasMore = newResponse.hasMore;
        } else {
          currentCache.items = newResponse.items;
          currentCache.total = newResponse.total;
          currentCache.hasMore = newResponse.hasMore;
        }
      },
      forceRefetch: ({ currentArg, previousArg }) =>
        currentArg?.before !== previousArg?.before ||
        currentArg?.conversationId !== previousArg?.conversationId,
      providesTags: (_result, _error, { conversationId }) => [
        { type: 'Message', id: conversationId },
      ],
    }),
    pollMessages: build.query<PollResponse, PollQueryArg>({
      query: ({ conversationId, after }) => {
        const params = new URLSearchParams();
        if (after) params.set('after', after);
        const qs = params.toString();
        return `/message/conversation/${conversationId}/poll${qs ? `?${qs}` : ''}`;
      },
    }),
    createMessage: build.mutation<Message, { conversationId: string; text: string }>({
      query: (body) => ({
        url: '/message',
        method: 'POST',
        body,
      }),
      invalidatesTags: (_result, _error, { conversationId }) => [
        { type: 'Message', id: conversationId },
      ],
    }),
    deleteMessage: build.mutation<void, { id: string; conversationId: string }>({
      query: ({ id }) => ({
        url: `/message/${id}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { conversationId }) => [
        { type: 'Message', id: conversationId },
      ],
    }),
  }),
});

export const {
  useGetMessagesQuery,
  usePollMessagesQuery,
  useCreateMessageMutation,
  useDeleteMessageMutation,
} = messagesApi;
