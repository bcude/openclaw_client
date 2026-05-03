import { baseApi } from '../../shared/api/baseApi';

export type GatewayState = 'connected' | 'connecting' | 'disconnected';

export interface GatewayStatus {
  state: GatewayState;
  /** Wall-clock ms of the last byte received on the current socket. 0
   *  when never connected. */
  lastSeenAt: number;
  /** Successive reconnect attempts since the last successful auth.
   *  Surfaced for diagnostics, not currently rendered. */
  reconnectAttempts: number;
  /** False when device-pairing files are missing — the dot turns into a
   *  red "needs pairing" cue regardless of socket state. */
  hasCredentials: boolean;
}

const gatewayApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getGatewayStatus: build.query<GatewayStatus, void>({
      query: () => '/gateway/status',
    }),
  }),
});

export const { useGetGatewayStatusQuery } = gatewayApi;
