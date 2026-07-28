import { Hono } from "hono";
import type { AppContext } from "../types";
import { readIdemKey, idemLookup, idemRecordOp } from "../lib/idempotency";

export const feedbackRoutes = new Hono<AppContext>();

// File a feedback / bug report from the in-app dialog. Pipes to GitHub Issues
// in the repo named by GH_FEEDBACK_REPO using GH_FEEDBACK_TOKEN. We attach only
// the reporter's display name so triage knows roughly who filed it — never the
// email, since the issue lives in a public repo and that would leak the address.
//
// Surface limits matter: keep the title + body short to avoid abuse and to
// keep issues skim-able. Real bug repros belong in attached screenshots /
// follow-up comments, not the initial submission.
feedbackRoutes.post("/", async (c) => {
	const { GH_FEEDBACK_REPO, GH_FEEDBACK_TOKEN } = c.env;
	if (!GH_FEEDBACK_REPO || !GH_FEEDBACK_TOKEN) {
		return c.json({ error: "feedback not configured" }, 503);
	}

	const email = c.var.email;
	const displayName = c.var.displayName || email.split("@")[0];

	// 冪等:重送同一 key 直接 replay 上次結果,不再開一張 GitHub issue。
	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		if (hit) return c.json(hit.body, hit.status as any);
	}

	type Body = { title?: string; body?: string; url?: string };
	const body = await c.req.json<Body>().catch(() => ({}) as Body);
	const title = (body.title || "").trim().slice(0, 200);
	const content = (body.body || "").trim().slice(0, 4000);
	const fromUrl = (body.url || "").trim().slice(0, 500);

	if (!title || !content) {
		return c.json({ error: "title and body required" }, 400);
	}

	const issueBody =
		`> 來自應用內回報\n\n${content}\n\n` +
		`---\n` +
		`**回報者**: ${displayName}\n` +
		(fromUrl ? `**頁面**: ${fromUrl}\n` : "") +
		`**UA**: ${c.req.header("user-agent") || "unknown"}\n` +
		`**時間**: ${new Date().toISOString()}`;

	const ghRes = await fetch(
		`https://api.github.com/repos/${GH_FEEDBACK_REPO}/issues`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${GH_FEEDBACK_TOKEN}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "hema-2026-feedback",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				title: `[Feedback] ${title}`,
				body: issueBody,
				labels: ["feedback", "from-app"],
			}),
		},
	);

	if (!ghRes.ok) {
		const detail = await ghRes.text().catch(() => "");
		// GitHub's error body can reveal token/scope/rate-limit state — log it
		// for triage, return only the status code to the client.
		console.error(
			`feedback: github rejected (${ghRes.status})`,
			detail.slice(0, 500),
		);
		return c.json({ error: "github rejected", status: ghRes.status }, 502);
	}

	const issue = (await ghRes.json()) as { html_url?: string; number?: number };
	const payload = { ok: true, url: issue.html_url, number: issue.number };

	// GitHub 成功後才記去重列(無 D1 batch,單獨 .run())。若這步失敗,下次
	// 重試會再開一張 issue —— 可接受的窗口(見設計文件威脅模型)。
	if (idemKey) {
		await idemRecordOp(c.env.DB, {
			email,
			key: idemKey,
			endpoint: "POST /feedback",
			status: 200,
			body: payload,
			now: Date.now(),
		}).run();
	}

	return c.json(payload);
});

// Lightweight probe so the frontend can hide the button when not configured.
feedbackRoutes.get("/_status", (c) => {
	const enabled = !!(c.env.GH_FEEDBACK_REPO && c.env.GH_FEEDBACK_TOKEN);
	return c.json({ enabled });
});
