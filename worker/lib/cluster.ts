// Greedy cosine clustering — group a user's wrong-question vectors into
// weakness themes. Each item joins the existing cluster whose centroid it's
// closest to (if similarity ≥ threshold), else starts a new one. Single-pass
// and order-dependent, which is fine for a diagnostic map (not a precise
// partition). Pure — no Vectorize/D1 — so it's unit-testable.

export type VecItem = { id: string; vector: number[] };
export type Cluster = { members: string[] };

export function clusterByThreshold(
	items: VecItem[],
	opts: { threshold: number },
): Cluster[] {
	const clusters: Array<{ members: string[]; sum: number[]; count: number }> = [];

	for (const item of items) {
		let best = -Infinity;
		let bestIdx = -1;
		for (let k = 0; k < clusters.length; k++) {
			const c = clusters[k];
			const centroid = c.sum.map((v) => v / c.count);
			const sim = cosine(item.vector, centroid);
			if (sim > best) {
				best = sim;
				bestIdx = k;
			}
		}

		if (bestIdx >= 0 && best >= opts.threshold) {
			const c = clusters[bestIdx];
			c.members.push(item.id);
			for (let i = 0; i < c.sum.length; i++) c.sum[i] += item.vector[i] ?? 0;
			c.count++;
		} else {
			clusters.push({ members: [item.id], sum: [...item.vector], count: 1 });
		}
	}

	return clusters
		.map((c) => ({ members: c.members }))
		.sort((a, b) => b.members.length - a.members.length);
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
