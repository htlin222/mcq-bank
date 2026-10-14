/**
 * 講義頁 → 歷屆考題。純函式,不碰 D1、不呼叫 Workers AI。
 *
 * 一頁留得下題,是因為這一頁寫到了那題自己的「稀有詞」:標籤、題幹裡的
 * 中文詞、或大寫縮寫。AML、ALL 這種幾十題共用的標籤單獨不夠 —— 否則
 * 總覽頁會被整科的題目灌滿。題庫裡沒有的主題(neuroblastoma)就是 0 筆,
 * 函式照樣回報,不把它當成失敗。
 */

export const TOP_N_PER_PAGE = 6;
export const MIN_PAGE_TEXT_LEN = 20;
/** 3–5 字的縮寫(PNH、ETP)容許比長詞更高的文件頻率。 */
export const RARE_ABBR_DF = 50;
/** 長詞與中文。超過這個文件頻率就只當同分時的加權,不能單獨成連結。 */
export const RARE_TERM_DF = 30;

const TAG_DENY = new Set([
	"低信心需覆核",
	"待補選項",
	"treatment",
	"diagnosis",
	"therapy",
	"disease",
	"prognosis",
	"management",
	"anemia",
	"anaemia",
	"fever",
	"bleeding",
	"infection",
]);

const ABBR_DENY = new Set(["AND", "OR", "NOT", "THE", "FOR", "WHO", "WITH"]);

export interface SlideQuestion {
	id: string;
	stem: string;
	tags: string[];
}

export interface SlidePage {
	page: number;
	text: string;
}

export interface SlideLink {
	page: number;
	question_id: string;
	/** 該頁最高分是 1,其餘按比例。面板用 rank 排序。 */
	score: number;
	rank: number;
	method: "tag" | "fts";
}

export interface LinkReport {
	links: SlideLink[];
	pages: number;
	shortPages: number;
	linkedPages: number;
	/** 文字夠長、但沒有任何稀有詞對得上。0 是結果,不是失敗。 */
	emptyPages: number;
}

interface Term {
	key: string;
	/** 拿去對頁面的原文。ASCII 保留原大小寫,比對時不分大小寫。 */
	surface: string;
	method: "tag" | "fts";
	/** 3–5 字的縮寫。文件頻率用較寬的上限。 */
	abbr: boolean;
	/**
	 * 中文詞、五字以上的標籤、或題幹用括號定義過的縮寫。
	 * 單獨一個沒被定義的三字母標籤(頁面上碰巧出現的 ALK)不成連結。
	 */
	strong: boolean;
}

export function parseSlideLinkArgs(argv: string[]): {
	slug: string;
	dryRun: boolean;
	remote: boolean;
} {
	const slug = argv.find((a) => a.startsWith("--slug="))?.slice("--slug=".length) ?? "";
	if (!slug) {
		throw new Error("需要 --slug=<lecture-slug>。沒有 slug 不會動到任何講義。");
	}
	return {
		slug,
		dryRun: argv.includes("--dry-run"),
		remote: argv.includes("--remote"),
	};
}

export function linkSlides(
	pages: SlidePage[],
	questions: SlideQuestion[],
	opts?: { rareAbbrDf?: number; rareTermDf?: number; topN?: number; minText?: number },
): LinkReport {
	const rareAbbrDf = opts?.rareAbbrDf ?? RARE_ABBR_DF;
	const rareTermDf = opts?.rareTermDf ?? RARE_TERM_DF;
	const topN = opts?.topN ?? TOP_N_PER_PAGE;
	const minText = opts?.minText ?? MIN_PAGE_TEXT_LEN;

	const perQuestion = questions.map((q) => ({ q, terms: termsForQuestion(q) }));
	const df = new Map<string, number>();
	for (const row of perQuestion) {
		for (const t of row.terms) df.set(t.key, (df.get(t.key) ?? 0) + 1);
	}

	const links: SlideLink[] = [];
	let shortPages = 0;
	let linkedPages = 0;
	let emptyPages = 0;

	for (const page of pages) {
		const text = (page.text ?? "").trim();
		if (text.length < minText) {
			shortPages += 1;
			continue;
		}
		const scored: { id: string; raw: number; method: "tag" | "fts" }[] = [];
		for (const row of perQuestion) {
			let best = 0;
			let strongHit = 0;
			let weakHit = 0;
			let method: "tag" | "fts" = "fts";
			for (const term of row.terms) {
				const n = df.get(term.key) ?? 0;
				if (n === 0 || n > (term.abbr ? rareAbbrDf : rareTermDf)) continue;
				if (!pageHas(text, term)) continue;
				const weight = term.surface.length / n;
				if (term.strong) strongHit += 1;
				else weakHit += 1;
				if (weight > best) {
					best = weight;
					method = term.method;
				}
			}
			// 一個強詞就夠。弱詞(沒在題幹定義過的短縮寫)要兩個一起出現,
			// 否則基因名或垃圾標籤會把整頁無關的題目拉進來。
			if (best === 0 || (strongHit === 0 && weakHit < 2)) continue;
			scored.push({ id: row.q.id, raw: (strongHit > 0 ? 10 : 0) + best, method });
		}
		if (scored.length === 0) {
			emptyPages += 1;
			continue;
		}
		scored.sort((a, b) => b.raw - a.raw || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const kept = scored.slice(0, topN);
		const best = kept[0].raw;
		kept.forEach((row, rank) => {
			links.push({
				page: page.page,
				question_id: row.id,
				score: row.raw / best,
				rank,
				method: row.method,
			});
		});
		linkedPages += 1;
	}

	return {
		links,
		pages: pages.length,
		shortPages,
		linkedPages,
		emptyPages,
	};
}

/** 該 slug 的 delete-then-insert。空的 links 仍會 DELETE,把過期連結清掉。 */
export function linkSql(slug: string, links: SlideLink[], now: number): string {
	const lines = [`DELETE FROM lecture_page_questions WHERE slug = '${escapeSql(slug)}';`];
	for (const link of links) {
		if (!Number.isFinite(link.score) || link.score < 0 || link.score > 1) {
			throw new Error(`bad score for ${link.question_id}`);
		}
		lines.push(
			`INSERT INTO lecture_page_questions (slug, page, question_id, score, rank, method, created_at) VALUES ('${escapeSql(slug)}', ${link.page}, '${escapeSql(link.question_id)}', ${link.score.toFixed(4)}, ${link.rank}, '${link.method}', ${now});`,
		);
	}
	return lines.join("\n") + "\n";
}

export function escapeSql(s: string): string {
	return s.replace(/'/g, "''");
}

function termsForQuestion(q: SlideQuestion): Term[] {
	const seen = new Set<string>();
	const defined = new Set<string>();
	for (const match of q.stem.matchAll(/\(([A-Z][A-Z0-9]{2,7})\)/g)) {
		defined.add(match[1].toLowerCase());
	}
	const out: Term[] = [];
	const add = (surface: string, method: "tag" | "fts", abbr: boolean, strong: boolean) => {
		const trimmed = surface.trim();
		if (trimmed.length < 3) return;
		const key = /[A-Za-z]/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
		if (TAG_DENY.has(key) || seen.has(key)) return;
		seen.add(key);
		out.push({ key, surface: trimmed, method, abbr, strong });
	};

	for (const tag of q.tags) {
		const trimmed = tag.trim();
		if (TAG_DENY.has(trimmed.toLowerCase())) continue;
		const abbr = /^[A-Za-z0-9.+-]{3,5}$/.test(trimmed);
		const short = /^[A-Za-z0-9.+-]{3,4}$/.test(trimmed);
		add(trimmed, "tag", abbr, !short || defined.has(trimmed.toLowerCase()));
	}
	for (const part of cjkParts(q.stem)) add(part, "fts", false, true);
	for (const abbr of q.stem.match(/\b[A-Z][A-Z0-9]{2,7}\b/g) ?? []) {
		if (ABBR_DENY.has(abbr)) continue;
		// 題幹裡沒被括號定義的短縮寫多半是垃圾 OCR 或方法學用字。
		if (abbr.length <= 4 && !defined.has(abbr.toLowerCase())) continue;
		add(abbr, "fts", true, true);
	}
	return out;
}

function cjkParts(stem: string): string[] {
	const runs = stem.match(/[\u3400-\u9fff]{4,}/g) ?? [];
	const out: string[] = [];
	for (const run of runs) {
		const stripped = run.replace(/下列有關|有關於|下列|何者|敘述|錯誤|正確|有關/g, " ");
		for (const piece of stripped.split(/\s+/)) {
			const term = piece.replace(/(的|之|與|和|及)+$/u, "");
			if (term.length >= 4 && term.length <= 16) out.push(term);
		}
	}
	return out;
}

function pageHas(text: string, term: Term): boolean {
	if (!term.abbr && !/[A-Za-z]/.test(term.surface)) return text.includes(term.surface);
	if (term.surface.length >= 6) return text.toLowerCase().includes(term.surface.toLowerCase());
	const body = term.surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^A-Za-z0-9])${body}(?:$|[^A-Za-z0-9])`, "i").test(text);
}
