// Confidence calibration — bucket answered attempts by the pre-answer
// confidence rating (1/2/3) and compute accuracy per bucket. A well-calibrated
// learner's accuracy rises with confidence; a flat or inverted curve exposes
// over/under-confidence. Pure so it's trivially testable.

export type ConfidenceEvent = { confidence: number; is_correct: number };

export type CalibrationBucket = {
	confidence: 1 | 2 | 3;
	n: number;
	correct: number;
	accuracy: number | null; // null when the bucket is empty
};

const LEVELS: Array<1 | 2 | 3> = [1, 2, 3];

export function calibration(events: ConfidenceEvent[]): CalibrationBucket[] {
	return LEVELS.map((level) => {
		const rows = events.filter((e) => e.confidence === level);
		const n = rows.length;
		const correct = rows.reduce((s, e) => s + (e.is_correct ? 1 : 0), 0);
		return {
			confidence: level,
			n,
			correct,
			accuracy: n === 0 ? null : correct / n,
		};
	});
}
