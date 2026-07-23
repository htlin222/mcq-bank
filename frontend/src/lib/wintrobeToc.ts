// Wintrobe's Clinical Hematology, 15e — the book's own Part / Section grouping
// of its 108 chapters, transcribed from the official table of contents. This is
// static reference metadata (the book structure is fixed), so it lives in the
// frontend rather than the DB — the textbook chapters are already imported as
// lecture_docs(kind='textbook', slug='wintrobe-ch<N>'); this only says how to
// nest them for browsing on /lectures.
//
// Parts 1/3/6/8 have no sections in the book — their chapters sit directly under
// the part. Parts 2/4/5/7 are divided into sections. The <TextbookToc> accordion
// renders that shape: a part with a single untitled section is drawn flat.

export interface WintrobeSection {
	// "" for parts the book doesn't subdivide — drawn without a section header.
	title: string;
	chapters: number[];
}

export interface WintrobePart {
	n: number;
	title: string;
	sections: WintrobeSection[];
}

// Inclusive chapter range [a, b].
function range(a: number, b: number): number[] {
	const out: number[] = [];
	for (let i = a; i <= b; i++) out.push(i);
	return out;
}

export const WINTROBE_TOC: WintrobePart[] = [
	{
		n: 1,
		title: "Laboratory Hematology",
		sections: [{ title: "", chapters: range(1, 4) }],
	},
	{
		n: 2,
		title: "The Normal Hematologic System",
		sections: [
			{ title: "Hematopoiesis", chapters: [5] },
			{ title: "The Erythrocyte", chapters: [6] },
			{ title: "Granulocytes and Monocytes", chapters: range(7, 10) },
			{ title: "The Lymphocytes", chapters: range(11, 16) },
			{ title: "Hemostasis", chapters: range(17, 21) },
		],
	},
	{
		n: 3,
		title: "Transfusion Medicine",
		sections: [{ title: "", chapters: range(22, 23) }],
	},
	{
		n: 4,
		title: "Disorders of Red Blood Cells",
		sections: [
			{ title: "Introduction", chapters: [24] },
			{ title: "Disorders of Iron Metabolism", chapters: range(25, 28) },
			{ title: "Hemolytic Anemia", chapters: range(29, 33) },
			{
				title: "Hereditary Disorders of Hemoglobin Structure and Synthesis",
				chapters: range(34, 36),
			},
			{ title: "Other Red Cell Disorders", chapters: range(37, 45) },
		],
	},
	{
		n: 5,
		title: "Disorders of Hemostasis and Coagulation",
		sections: [
			{ title: "Introduction", chapters: [46] },
			{ title: "Thrombocytopenia", chapters: range(47, 53) },
			{ title: "Coagulation Disorders", chapters: range(54, 55) },
			{ title: "Thrombosis", chapters: [56] },
		],
	},
	{
		n: 6,
		title: "Disorders of Leukocytes, Immunodeficiency, and the Spleen",
		sections: [{ title: "", chapters: range(57, 67) }],
	},
	{
		n: 7,
		title: "Hematologic Malignancies",
		sections: [
			{ title: "General Aspects", chapters: range(68, 72) },
			{ title: "The Acute Leukemias", chapters: range(73, 81) },
			{ title: "Myeloproliferative Disorders", chapters: range(82, 87) },
			{ title: "Lymphoproliferative Disorders", chapters: range(88, 96) },
			{ title: "Plasma Cell Dyscrasias", chapters: range(97, 103) },
		],
	},
	{
		n: 8,
		title: "Hematopoietic Cellular Therapy",
		sections: [{ title: "", chapters: range(104, 108) }],
	},
];

// slug ("wintrobe-ch76") → chapter number (76), or null if it doesn't match.
export function chapterNumFromSlug(slug: string): number | null {
	const m = /^wintrobe-ch(\d+)$/.exec(slug);
	return m ? parseInt(m[1], 10) : null;
}
