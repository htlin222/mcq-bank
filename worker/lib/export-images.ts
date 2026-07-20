// Optional base64 image embedding for the md / html export formats.
//
// The R2 bucket STAYS PRIVATE (CLAUDE.md). Bytes are read with the same
// `env.R2.get(key)` call worker/routes/images.ts uses to serve /img/<key>;
// nothing here changes bucket permissions or produces a public URL.
//
// Budget: free-plan Workers give 10 ms CPU and base64 is the expensive part,
// so this is capped by count AND by cumulative bytes. Whatever doesn't fit
// stays a /img/<key> link and the caller notes it in the file footer.

import type { R2Bucket } from "@cloudflare/workers-types";
import type { ExportItem } from "./export-doc.ts";

export const MAX_EMBED_COUNT = 20;
export const MAX_EMBED_BYTES = 4_000_000;
// Workers cap simultaneous outbound connections; 6 keeps us well clear.
export const EMBED_CONCURRENCY = 6;

type PMNode = { type?: string; attrs?: Record<string, any>; content?: PMNode[] };

// Walk every doc on every item for local /img/<key> images. External http(s)
// images are left alone (they're already absolute) and anything with a ".."
// segment is refused — same posture as worker/routes/images.ts's traversal
// guard.
export function collectImageKeys(items: ExportItem[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const visit = (n: unknown) => {
		if (!n || typeof n !== "object") return;
		const node = n as PMNode;
		if (node.type === "image") {
			const src = node.attrs?.src;
			if (typeof src === "string" && src.startsWith("/img/")) {
				const key = src.slice("/img/".length);
				if (key && !key.split("/").includes("..") && !seen.has(key)) {
					seen.add(key);
					out.push(key);
				}
			}
		}
		if (Array.isArray(node.content)) for (const c of node.content) visit(c);
	};
	for (const item of items) {
		visit(item.explanation);
		visit(item.note);
	}
	return out;
}

export function planEmbed(
	keys: string[],
	opts: { maxCount?: number } = {},
): { embed: string[]; skipped: string[] } {
	const max = opts.maxCount ?? MAX_EMBED_COUNT;
	return { embed: keys.slice(0, max), skipped: keys.slice(max) };
}

function toBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = "";
	// Chunked so a large image doesn't blow the argument limit of fromCharCode.
	for (let i = 0; i < bytes.length; i += 8192) {
		bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return btoa(bin);
}

// Returns a map keyed by the `/img/<key>` src the renderer will see, so
// RenderOpts.imageSrc is a plain lookup with a link fallback.
export async function fetchEmbeds(
	r2: R2Bucket,
	keys: string[],
	opts: { maxBytes?: number; concurrency?: number } = {},
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (keys.length === 0) return out;
	const maxBytes = opts.maxBytes ?? MAX_EMBED_BYTES;
	const concurrency = Math.max(1, opts.concurrency ?? EMBED_CONCURRENCY);

	let used = 0;
	let next = 0;
	const worker = async () => {
		for (;;) {
			const i = next++;
			if (i >= keys.length || used >= maxBytes) return;
			const key = keys[i];
			try {
				const obj = await r2.get(key);
				if (!obj) continue;
				const buf = await obj.arrayBuffer();
				if (used + buf.byteLength > maxBytes) {
					// Stop rather than skip-and-continue: keeps output deterministic
					// (a prefix of the list) instead of size-order dependent.
					used = maxBytes;
					return;
				}
				used += buf.byteLength;
				const mime = obj.httpMetadata?.contentType || "application/octet-stream";
				out.set(`/img/${key}`, `data:${mime};base64,${toBase64(buf)}`);
			} catch {
				// Unreadable object — leave it as a link.
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()),
	);
	return out;
}
