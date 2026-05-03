/* The other route modules in this folder export multiple handlers, so
 * `import * as controller` reads naturally there. This one just exposes
 * a single GET — keeping the same pattern for consistency rather than
 * switching to a default export. */
/* eslint-disable import/prefer-default-export */
import { RequestHandler } from 'express';
import { gateway } from '../../services/openclawGateway';

/**
 * GET /api/gateway/status — cheap, unauthenticated snapshot of the
 * WebSocket connection to the OpenClaw daemon. Polled by the chat UI
 * (5 s cadence) to render the green/yellow/red dot in the message input.
 *
 * Returning unauthenticated because the response carries no PII (just a
 * connection state enum + counter) and the chat shell needs it before
 * the user is necessarily logged in to render a useful "gateway down"
 * cue. If we ever add detailed timing/credentials in here, gate it.
 */
export const status: RequestHandler = (_req, res, next) => {
  try {
    return res.json(gateway.getStatus());
  } catch (error) {
    return next(error);
  }
};
