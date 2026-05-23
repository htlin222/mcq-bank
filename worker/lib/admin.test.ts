import { test } from "node:test";
import assert from "node:assert/strict";
import { adminEmails, isAdminEmail } from "./admin.ts";

test("default admin includes ppoiu87@gmail.com", () => {
	assert.equal(isAdminEmail("ppoiu87@gmail.com"), true);
});

test("admin matching is case-insensitive and trims whitespace", () => {
	assert.equal(isAdminEmail("  PPOIU87@gmail.com "), true);
});

test("ADMIN_EMAILS env extends the default admin list", () => {
	assert.equal(
		isAdminEmail("other@example.com", {
			ADMIN_EMAILS: " other@example.com, second@example.com ",
		}),
		true,
	);
	assert.deepEqual(
		[...adminEmails({ ADMIN_EMAILS: "other@example.com" })].sort(),
		["other@example.com", "ppoiu87@gmail.com"],
	);
});

test("non-admin emails are rejected", () => {
	assert.equal(isAdminEmail("student@example.com"), false);
	assert.equal(isAdminEmail(null), false);
});
