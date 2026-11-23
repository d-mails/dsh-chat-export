/**
 * Host half of DSH Chat Export.
 *
 * Registers three same-origin POST routes with the Web carrier. Each reads one
 * live-preferred Session snapshot through `sessionQuery` and returns data to the
 * same browser that asked for it. Nothing leaves the local machine.
 */

import {
  BUILD_PATH,
  SESSIONS_PATH,
  TURNS_PATH,
  createBuildHandler,
  createSessionsHandler,
  createTurnsHandler,
} from './src/production.js';

export const name = 'chat-export';
export const inject = ['sessionQuery', 'webServer'];

export function apply(ctx) {
  const trustedHosts = [];
  try {
    const runtime = ctx.get?.('webRuntime');
    if (Array.isArray(runtime?.trustedHosts)) trustedHosts.push(...runtime.trustedHosts);
  } catch {
    // optional service
  }
  try {
    trustedHosts.push(new URL(ctx.webServer.getOrigin()).host);
  } catch {
    // getOrigin throws before the server listens
  }

  const options = {
    trustedHosts,
    listSessions: () => ctx.sessionQuery.listSessions(),
    readTitleSnapshots: (sessionIds) => ctx.sessionQuery.readTitleSnapshots(sessionIds),
    readSession: (sessionId) => ctx.sessionQuery.readSession(sessionId),
    onError: (error) => {
      try {
        ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // Never let logging take down a request.
      }
    },
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: SESSIONS_PATH, handler: createSessionsHandler(options) }),
    'chat-export: session list route',
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: TURNS_PATH, handler: createTurnsHandler(options) }),
    'chat-export: turn preview route',
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: BUILD_PATH, handler: createBuildHandler(options) }),
    'chat-export: build route',
  );
}
