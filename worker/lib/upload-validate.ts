// Shared image-upload validation — originally inline in routes/upload.ts.
// Pulled out so worker/routes/smear-community.ts (投稿 submission image) can
// reuse the exact same size/type rules instead of re-implementing them with
// a subtly different limit or MIME list.
export const ALLOWED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
]);
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

export type UploadedFile = Blob & { type: string; size: number };

export type ImageValidation =
	| { ok: true }
	| { ok: false; status: 400 | 413 | 415; error: string };

/** Runs the same checks `/api/upload` applies, for any other route that accepts a raw image file. */
export function validateImageFile(
	file: UploadedFile | string | null | undefined,
): ImageValidation {
	if (!file || typeof file === 'string') return { ok: false, status: 400, error: 'no file' };
	if (file.size > MAX_IMAGE_SIZE) return { ok: false, status: 413, error: 'file >10MB' };
	if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
		return { ok: false, status: 415, error: `unsupported type: ${file.type}` };
	}
	return { ok: true };
}
