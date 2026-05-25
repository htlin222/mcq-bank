import { test } from "node:test";
import assert from "node:assert/strict";
import { adminEmails, isAdminEmail } from "./admin.ts";

test("ADMIN_EMAILS env populates the admin set", () => {
	assert.equal(
		isAdminEmail("admin@example.com", { ADMIN_EMAILS: "admin@example.com" }),
		true,
	);
});

test("admin matching is case-insensitive and trims whitespace", () => {
	assert.equal(
		isAdminEmail("  ADMIN@example.com ", { ADMIN_EMAILS: "admin@example.com" }),
		true,
	);
});

test("multi-value ADMIN_EMAILS is split on commas", () => {
	const env = { ADMIN_EMAILS: " first@example.com, second@example.com " };
	assert.equal(isAdminEmail("first@example.com", env), true);
	assert.equal(isAdminEmail("second@example.com", env), true);
	assert.deepEqual(
		[...adminEmails(env)].sort(),
		["first@example.com", "second@example.com"],
	);
});

test("no ADMIN_EMAILS configured means no admins", () => {
	assert.equal(isAdminEmail("anyone@example.com"), false);
	assert.equal(adminEmails().size, 0);
});

test("non-admin emails are rejected", () => {
	const env = { ADMIN_EMAILS: "admin@example.com" };
	assert.equal(isAdminEmail("student@example.com", env), false);
	assert.equal(isAdminEmail(null, env), false);
});
