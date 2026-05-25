import {
	createEmptyCard,
	fsrs,
	Rating,
	State,
	type Card,
	type Grade,
	type RecordLogItem,
} from "ts-fsrs";

export type FsrsRating = "again" | "hard" | "good" | "easy";

export type FsrsCardRow = {
	due_at: number;
	stability: number;
	difficulty: number;
	elapsed_days: number;
	scheduled_days: number;
	learning_steps: number;
	reps: number;
	lapses: number;
	state: number;
	last_review_at: number | null;
};

export type FsrsPreview = {
	due_at: number;
	scheduled_days: number;
	state: number;
};

const scheduler = fsrs({
	request_retention: 0.9,
	maximum_interval: 36500,
	enable_fuzz: false,
	enable_short_term: true,
	learning_steps: ["1m", "10m"],
	relearning_steps: ["10m"],
});

export function ratingFromInput(input: unknown): Grade | null {
	switch (String(input || "").toLowerCase()) {
		case "again":
			return Rating.Again;
		case "hard":
			return Rating.Hard;
		case "good":
			return Rating.Good;
		case "easy":
			return Rating.Easy;
		default:
			return null;
	}
}

export function ratingName(rating: Grade): FsrsRating {
	switch (rating) {
		case Rating.Again:
			return "again";
		case Rating.Hard:
			return "hard";
		case Rating.Good:
			return "good";
		case Rating.Easy:
			return "easy";
	}
}

export function rowToCard(row: FsrsCardRow | null, now: number): Card {
	if (!row) return createEmptyCard(now);
	return {
		due: new Date(row.due_at),
		stability: row.stability,
		difficulty: row.difficulty,
		elapsed_days: row.elapsed_days,
		scheduled_days: row.scheduled_days,
		learning_steps: row.learning_steps,
		reps: row.reps,
		lapses: row.lapses,
		state: row.state as State,
		last_review: row.last_review_at ? new Date(row.last_review_at) : undefined,
	};
}

export function serializeCard(card: Card): FsrsCardRow {
	return {
		due_at: card.due.getTime(),
		stability: card.stability,
		difficulty: card.difficulty,
		elapsed_days: card.elapsed_days,
		scheduled_days: card.scheduled_days,
		learning_steps: card.learning_steps,
		reps: card.reps,
		lapses: card.lapses,
		state: card.state,
		last_review_at: card.last_review?.getTime() ?? null,
	};
}

export function nextFsrsCard(
	row: FsrsCardRow | null,
	now: number,
	rating: Grade,
): RecordLogItem {
	return scheduler.next(rowToCard(row, now), new Date(now), rating);
}

export function previewFsrs(row: FsrsCardRow | null, now: number) {
	const preview = scheduler.repeat(rowToCard(row, now), new Date(now));
	return {
		again: serializePreview(preview[Rating.Again]),
		hard: serializePreview(preview[Rating.Hard]),
		good: serializePreview(preview[Rating.Good]),
		easy: serializePreview(preview[Rating.Easy]),
	};
}

export function retrievability(row: FsrsCardRow | null, now: number): number | null {
	if (!row || !row.last_review_at || row.state === State.New) return null;
	try {
		return scheduler.get_retrievability(rowToCard(row, now), new Date(now), false);
	} catch {
		return null;
	}
}

function serializePreview(item: RecordLogItem): FsrsPreview {
	return {
		due_at: item.card.due.getTime(),
		scheduled_days: item.card.scheduled_days,
		state: item.card.state,
	};
}
