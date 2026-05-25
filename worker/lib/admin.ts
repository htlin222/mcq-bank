import type { Env } from "../types";

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

// Admin allow-list comes exclusively from wrangler.toml [vars] ADMIN_EMAILS
// (or the matching .dev.vars override). Forks just edit that file — no
// hard-coded fallback so an unconfigured deploy has zero admins.
export function adminEmails(env?: Pick<Env, "ADMIN_EMAILS">): Set<string> {
	const configured = env?.ADMIN_EMAILS?.split(",") ?? [];
	const emails = configured.map(normalizeEmail).filter(Boolean);
	return new Set(emails);
}

export function isAdminEmail(
	email: string | null | undefined,
	env?: Pick<Env, "ADMIN_EMAILS">,
): boolean {
	if (!email) return false;
	return adminEmails(env).has(normalizeEmail(email));
}
