// Build a blind-solving query for OpenEvidence: stem + options only, no answer.
// We send a labelled multi-option prompt so OpenEvidence can frame its reply as
// a choice analysis, not just a tangent. Truncate generously to avoid hitting
// URL length limits on either OpenEvidence or the user's browser.
export function buildOpenEvidenceUrl(data: {
	stem: string;
	options: Record<string, string>;
}): string {
	const optionLines = ["A", "B", "C", "D", "E"]
		.map((L) => (data.options[L] ? `(${L}) ${data.options[L]}` : null))
		.filter(Boolean)
		.join("\n");
	const query =
		`${data.stem}\n\nOptions:\n${optionLines}\n\nWhich option is best supported by current evidence, and why?`.slice(
			0,
			1800,
		);
	const url = new URL("https://www.openevidence.com/ask");
	url.searchParams.set("query", query);
	url.searchParams.set("configName", "prod");
	return url.toString();
}

// Build an OpenEvidence query from a free-text selection (e.g. a lecture-slide
// snippet). No options framing — just the raw text, truncated to the same URL
// budget as the question helper.
export function buildOpenEvidenceUrlFromText(text: string): string {
	const query = text.slice(0, 1800);
	const url = new URL("https://www.openevidence.com/ask");
	url.searchParams.set("query", query);
	url.searchParams.set("configName", "prod");
	return url.toString();
}
