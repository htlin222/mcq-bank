// aml_m2 曾經把 t(8;21) 跟 dysplastic eosinophil 寫在一起。
// 粗大嗜鹼性顆粒的嗜酸性球前驅細胞是 inv(16)/M4Eo 的特徵。
// 這支鎖的是來源檔,正式機要另外用非破壞性匯入才會跟上。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Note = {
	dx_id: string;
	content_json: { content?: { content?: { text?: string }[] }[] };
};

function texts(note: Note): string {
	const chunks: string[] = [];
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		const rec = node as { text?: unknown; content?: unknown };
		if (typeof rec.text === "string") chunks.push(rec.text);
		if (Array.isArray(rec.content)) rec.content.forEach(walk);
	};
	walk(note.content_json);
	return chunks.join("\n");
}

const notes = JSON.parse(
	readFileSync(new URL("./data/dx-notes.json", import.meta.url), "utf8"),
) as Note[];

test("aml_m2 不再把嗜酸性球前驅細胞算進 t(8;21)", () => {
	const note = notes.find((n) => n.dx_id === "aml_m2");
	assert.ok(note);
	const body = texts(note);
	assert.match(body, /t\(8;21\)/);
	assert.match(body, /inv\(16\)\/M4Eo/);
	assert.doesNotMatch(body, /dysplastic eosinophil/);
	assert.doesNotMatch(body, /異常粗大的嗜酸性球前驅細胞/);
});

test("aml_m4 仍把嗜鹼性顆粒的嗜酸性球放在 inv(16)", () => {
	const note = notes.find((n) => n.dx_id === "aml_m4");
	assert.ok(note);
	const body = texts(note);
	assert.match(body, /inv\(16\)/);
	assert.match(body, /basophilic/);
});
