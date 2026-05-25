import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authMiddleware } from './lib/auth';
import type { AppContext } from './types';

import { meRoutes } from './routes/me';
import { questionsRoutes } from './routes/questions';
import { explanationsRoutes } from './routes/explanations';
import { notesRoutes } from './routes/notes';
import { commentsRoutes } from './routes/comments';
import { uploadRoutes } from './routes/upload';
import { imagesRoutes } from './routes/images';
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

const app = new Hono<AppContext>();

app.use('*', logger());

// CORS — Pages and Worker share the same origin in production behind Access,
// but local dev runs Pages on :5173 and Worker on :8787.
app.use(
  '*',
  cors({
    origin: (origin) => origin, // reflect (acceptable since Access gates upstream)
    credentials: true,
    allowHeaders: ['Content-Type', 'X-Dev-Email', 'X-Lock-Token'],
  })
);

// Health check (no auth)
app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

// Read-only question API for the `/mcq` skill. Has its own API-key auth
// (worker/lib/apikey.ts) and is registered BEFORE the Access middleware so it
// never inherits Access gating — the path is Access-bypassed at the edge.
app.route('/api/mcq', mcqRoutes);

// All other routes require Access auth
app.use('/api/*', authMiddleware);
app.use('/img/*', authMiddleware);

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
app.route('/api/exam', examRoutes);
app.route('/api/review', reviewRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/folders', foldersRoutes);
app.route('/api/bookmarks', bookmarksRoutes);
app.route('/api/feedback', feedbackRoutes);

app.notFound((c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  console.error('unhandled', err);
  return c.json({ error: 'internal error', detail: String(err) }, 500);
});

export default app;
