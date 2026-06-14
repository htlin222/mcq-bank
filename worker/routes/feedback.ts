import { Hono } from 'hono';
import type { AppContext } from '../types';

export const feedbackRoutes = new Hono<AppContext>();

// File a feedback / bug report from the in-app dialog. Pipes to GitHub Issues
// in the repo named by GH_FEEDBACK_REPO using GH_FEEDBACK_TOKEN. We attach the
// reporter's email + display name so triage knows who to follow up with.
//
// Surface limits matter: keep the title + body short to avoid abuse and to
// keep issues skim-able. Real bug repros belong in attached screenshots /
// follow-up comments, not the initial submission.
feedbackRoutes.post('/', async (c) => {
  const { GH_FEEDBACK_REPO, GH_FEEDBACK_TOKEN } = c.env;
  if (!GH_FEEDBACK_REPO || !GH_FEEDBACK_TOKEN) {
    return c.json({ error: 'feedback not configured' }, 503);
  }

  const email = c.var.email;
  const displayName = c.var.displayName || email.split('@')[0];

  type Body = { title?: string; body?: string; url?: string };
  const body = await c.req.json<Body>().catch(() => ({} as Body));
  const title = (body.title || '').trim().slice(0, 200);
  const content = (body.body || '').trim().slice(0, 4000);
  const fromUrl = (body.url || '').trim().slice(0, 500);

  if (!title || !content) {
    return c.json({ error: 'title and body required' }, 400);
  }

  const issueBody =
    `> 來自應用內回報\n\n${content}\n\n` +
    `---\n` +
    `**回報者**: ${displayName} <${email}>\n` +
    (fromUrl ? `**頁面**: ${fromUrl}\n` : '') +
    `**UA**: ${c.req.header('user-agent') || 'unknown'}\n` +
    `**時間**: ${new Date().toISOString()}`;

  const ghRes = await fetch(
    `https://api.github.com/repos/${GH_FEEDBACK_REPO}/issues`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GH_FEEDBACK_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'hema-2026-feedback',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `[Feedback] ${title}`,
        body: issueBody,
        labels: ['feedback', 'from-app'],
      }),
    },
  );

  if (!ghRes.ok) {
    const detail = await ghRes.text().catch(() => '');
    // GitHub's error body can reveal token/scope/rate-limit state — log it
    // for triage, return only the status code to the client.
    console.error(`feedback: github rejected (${ghRes.status})`, detail.slice(0, 500));
    return c.json({ error: 'github rejected', status: ghRes.status }, 502);
  }

  const issue = (await ghRes.json()) as { html_url?: string; number?: number };
  return c.json({ ok: true, url: issue.html_url, number: issue.number });
});

// Lightweight probe so the frontend can hide the button when not configured.
feedbackRoutes.get('/_status', (c) => {
  const enabled = !!(c.env.GH_FEEDBACK_REPO && c.env.GH_FEEDBACK_TOKEN);
  return c.json({ enabled });
});
