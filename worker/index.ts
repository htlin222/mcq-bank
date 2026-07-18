import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authMiddleware } from './lib/auth';
import { syncRoster } from './lib/roster-sync';
import type { AppContext, Env } from './types';

import { meRoutes } from './routes/me';
import { questionsRoutes } from './routes/questions';
import { explanationsRoutes } from './routes/explanations';
import { notesRoutes } from './routes/notes';
import { commentsRoutes } from './routes/comments';
import { uploadRoutes } from './routes/upload';
import { imagesRoutes } from './routes/images';
import { pdfRoutes } from './routes/pdf';
import { examRoutes } from './routes/exam';
import { reviewRoutes } from './routes/review';
import { aiRoutes } from './routes/ai';
import { notificationsRoutes } from './routes/notifications';
import { usersRoutes } from './routes/users';
import { searchRoutes } from './routes/search';
import { foldersRoutes } from './routes/folders';
import { bookmarksRoutes } from './routes/bookmarks';
import { feedbackRoutes } from './routes/feedback';
import { challengesRoutes, questionChallengeRoutes } from './routes/challenges';
import { mcqRoutes } from './routes/mcq';
import { lectureRoutes } from './routes/lectures';
import { chatRoutes } from './routes/chat';
import { oeRoutes } from './routes/oe';
import { stateRoutes } from './routes/state';

// Durable Object classes must be exported from the Worker entrypoint.
export { ChatRoom } from './chat-room';
export { UserState } from './user-state';

const app = new Hono<AppContext>();

app.use('*', logger());

// CORS — Pages and Worker share the same origin in production behind Access,
// but local dev runs Pages on :5173 and Worker on :8787. Allowlist instead of
// reflecting: with `credentials: true`, reflecting any Origin would let an
// arbitrary website ride the CF_Authorization cookie if it is ever sent
// cross-site (e.g. an Access SameSite config change).
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      if (!origin) return origin;
      if (origin === new URL(c.req.url).origin) return origin;
      try {
        const { hostname } = new URL(origin);
        if (hostname === 'localhost' || hostname === '127.0.0.1') return origin;
      } catch {
        // fall through — malformed Origin is not allowed
      }
      return null;
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'X-Dev-Email', 'X-Lock-Token'],
  })
);

// Health check (no auth)
app.get('/api/health', (c) => c.json({ ok: true, service: 'hema-2026-api', ts: Date.now() }));

// Read-only question API for the `/mcq` skill. Has its own API-key auth
// (worker/lib/apikey.ts) and is registered BEFORE the Access middleware so it
// never inherits Access gating — the path is Access-bypassed at the edge.
app.route('/api/mcq', mcqRoutes);

// All other routes require Access auth
app.use('/api/*', authMiddleware);
app.use('/img/*', authMiddleware);
app.use('/pdf/*', authMiddleware);

app.route('/api/me', meRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/questions', questionsRoutes);
app.route('/api/questions', explanationsRoutes); // /:id/explanation/*
app.route('/api/questions', notesRoutes);        // /:id/note
app.route('/api/questions', commentsRoutes);     // /:id/comments
app.route('/api/questions', questionChallengeRoutes); // /:id/challenges*
app.route('/api/challenges', challengesRoutes);  // /:cid/votes etc.
app.route('/api/upload', uploadRoutes);
app.route('/img', imagesRoutes);
app.route('/pdf', pdfRoutes);
app.route('/api/exam', examRoutes);
app.route('/api/review', reviewRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/folders', foldersRoutes);
app.route('/api/bookmarks', bookmarksRoutes);
app.route('/api/feedback', feedbackRoutes);
app.route('/api/lectures', lectureRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/oe', oeRoutes);
app.route('/api/state', stateRoutes);

app.notFound((c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  // Detail goes to the log (`wrangler tail`), never to the client.
  console.error('unhandled', c.req.method, c.req.path, err);
  return c.json({ error: 'internal error' }, 500);
});

export default {
  fetch: app.fetch,
  // Cron Trigger (wrangler.toml [triggers].crons) — daily roster → Access
  // policy + D1 users sync. New people in the Google Sheet get login access
  // and a seeded users row without anyone running scripts/sync-access.ts.
  // Revoke-on-removal: the policy include[] is replaced with the merged list.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      syncRoster(env)
        .then((r) =>
          console.log(
            `[cron roster-sync] ok: ${r.roster} sheet + ${r.admins} admin → ${r.merged} merged (policy ${r.policyId})`,
          ),
        )
        .catch((e) => {
          console.error('[cron roster-sync] failed', e);
          throw e; // surface as a failed cron invocation in observability
        }),
    );
  },
};
