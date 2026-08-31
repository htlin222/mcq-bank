import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecall } from './recall.ts';
import type { ChatMessage } from './ChatProvider.tsx';

// ⚠️ 這支守的不是「state 有沒有更新」,是**「內容還有幾份」**。撤回最容易錯的
// 地方是漏掉副本,而漏掉的症狀是「按了撤回,字還在」—— 而且只有在有人引用過
// 那則訊息時才看得到,所以自己測的時候多半不會發現。

const SECRET = '這句話等一下要撤回';

function msg(over: Partial<ChatMessage>): ChatMessage {
	return {
		id: 1,
		email: 'a@example.com',
		name: 'A',
		text: 'hi',
		mentions: '[]',
		mention_all: 0,
		reply_to: null,
		reply_name: null,
		reply_snippet: null,
		created_at: 1_700_000_000_000,
		deleted_at: null,
		...over,
	};
}

test('訊息本身變成墓碑:文字抹掉、蓋上時間', () => {
	const out = applyRecall([msg({ id: 7, text: SECRET })], 7, 999);
	assert.equal(out[0].text, '');
	assert.equal(out[0].deleted_at, 999);
});

test('引用它的回覆,快照要一起抹掉 —— 而且是 null 不是空字串', () => {
	const before = [
		msg({ id: 7, text: SECRET }),
		msg({ id: 8, email: 'b@example.com', text: '同意', reply_to: 7, reply_name: 'A', reply_snippet: SECRET }),
		msg({ id: 9, email: 'c@example.com', text: '+1', reply_to: 7, reply_name: 'A', reply_snippet: SECRET }),
	];
	const out = applyRecall(before, 7, 999);
	// null 是 MessageItem 畫「訊息已撤回」的判準;空字串會畫成一個空的引用列。
	assert.equal(out[1].reply_snippet, null);
	assert.equal(out[2].reply_snippet, null);
	// 這一條才是重點:整份清單裡不該再有那段文字的任何一份。
	assert.ok(
		!JSON.stringify(out).includes(SECRET),
		'撤回之後清單裡還留著原文的副本',
	);
});

test('引用**別則**訊息的回覆不受影響', () => {
	const other = msg({ id: 8, reply_to: 6, reply_name: 'Z', reply_snippet: '別人的話' });
	const out = applyRecall([msg({ id: 7 }), other], 7, 999);
	assert.equal(out[1].reply_snippet, '別人的話');
});

test('墓碑自己的引用區也要收掉 —— 泡泡整顆換掉了,留著只是一行空的引用', () => {
	const out = applyRecall(
		[msg({ id: 7, text: SECRET, reply_to: 3, reply_name: 'Z', reply_snippet: '被回的那句' })],
		7,
		999,
	);
	assert.equal(out[0].reply_to, null);
	assert.equal(out[0].reply_snippet, null);
	assert.ok(!JSON.stringify(out).includes('被回的那句'));
});

test('@ 標記一起清掉 —— 留著的話 toast/通知的判準還會把它當成一次 @', () => {
	const out = applyRecall(
		[msg({ id: 7, mentions: '["b@example.com"]', mention_all: 1 })],
		7,
		999,
	);
	assert.equal(out[0].mentions, '[]');
	assert.equal(out[0].mention_all, 0);
});

test('沒有那則訊息時原樣回傳(重送 / 已經被 trim 掉)', () => {
	const before = [msg({ id: 7, text: SECRET })];
	const out = applyRecall(before, 99, 999);
	assert.deepEqual(out, before);
});
