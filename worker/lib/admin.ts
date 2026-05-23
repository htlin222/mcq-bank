import type { Env } from "../types";

const DEFAULT_ADMIN_EMAILS = ["ppoiu87@gmail.com"];

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function adminEmails(env?: Pick<Env, "ADMIN_EMAILS">): Set<string> {
	const configured = env?.ADMIN_EMAILS?.split(",") ?? [];
	const emails = [...DEFAULT_ADMIN_EMAILS, ...configured]
		.map(normalizeEmail)
		.filter(Boolean);
	return new Set(emails);
}

export function isAdminEmail(
	email: string | null | undefined,
	env?: Pick<Env, "ADMIN_EMAILS">,
): boolean {
	if (!email) return false;
	return adminEmails(env).has(normalizeEmail(email));
}
