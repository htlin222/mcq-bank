// Tiny typed fetch wrapper. Access cookie is sent automatically when on the
// real domain; for local dev, Vite proxy injects X-Dev-Email.

export class ApiError extends Error {
  constructor(public status: number, public data: any) {
    super(`API ${status}: ${JSON.stringify(data)}`);
  }
}

// When a Cloudflare Access session expires the *edge* answers with a 302 to
// the login page (the Worker itself always replies 401 JSON). fetch() follows
// redirects, so we get status 200 + res.ok === true + an HTML body from
// cloudflareaccess.com — which used to be swallowed as if it were data, since
// the JSON.parse below falls back to handing the raw text back to the caller.
//
// Detect it by provenance, never by status, and recover with a *full*
// navigation so the browser actually follows Access's redirect. A SPA
// navigation would not. sw.ts has the same check for requests it serves.
function assertNotAccessRedirect(res: Response): void {
  let crossOrigin = false;
  if (res.url) {
    try {
      crossOrigin = new URL(res.url, location.origin).origin !== location.origin;
    } catch {
      crossOrigin = true;
    }
  }
  if (!res.redirected && !crossOrigin) return;
  if (location.pathname !== '/') location.assign('/');
  throw new ApiError(401, { error: 'access_session_expired' });
}

async function request<T>(
  method: string,
  path: string,
  body?: any,
  opts: { isForm?: boolean; idempotencyKey?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  let bodyPayload: BodyInit | undefined;

  if (body !== undefined) {
    if (opts.isForm) {
      bodyPayload = body as FormData;
    } else {
      headers['Content-Type'] = 'application/json';
      bodyPayload = JSON.stringify(body);
    }
  }

  // 冪等:呼叫端可帶「每次動作一個」的穩定 key,重送時沿用同一個。
  // 沒帶就完全不加 header,伺服器端行為與現況一致(向後相容)。
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: bodyPayload,
    credentials: 'include',
  });

  assertNotAccessRedirect(res);

  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get:   <T = any>(path: string) => request<T>('GET', path),
  post:  <T = any>(path: string, body?: any, idempotencyKey?: string) =>
    request<T>('POST', path, body, { idempotencyKey }),
  put:   <T = any>(path: string, body?: any, idempotencyKey?: string) =>
    request<T>('PUT', path, body, { idempotencyKey }),
  patch: <T = any>(path: string, body?: any) => request<T>('PATCH', path, body),
  del:   <T = any>(path: string) => request<T>('DELETE', path),
  // File downloads can't go through request(): it always JSON.parses the body.
  // Reads the filename from Content-Disposition (RFC 5987 first, ASCII
  // fallback second) so 中文 filenames survive.
  download: async (path: string, body?: any): Promise<void> => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      credentials: 'include',
    });
    // Same trap as request(): an expired Access session would otherwise be
    // downloaded as a file full of login-page HTML.
    assertNotAccessRedirect(res);
    if (!res.ok) {
      const text = await res.text();
      let data: any = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      throw new ApiError(res.status, data);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const ascii = /filename="([^"]*)"/i.exec(cd);
    let name = 'export';
    if (utf8) {
      try { name = decodeURIComponent(utf8[1]); } catch { name = utf8[1]; }
    } else if (ascii) {
      name = ascii[1];
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  upload:<T = any>(path: string, file: File, idempotencyKey?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<T>('POST', path, fd, { isForm: true, idempotencyKey });
  },
  // Like upload(), but for endpoints whose multipart body carries more than a
  // single `file` field (e.g. /api/smear/submissions: image + proposedAnswer +
  // explanationText) — the caller builds the FormData itself.
  postForm: <T = any>(path: string, fd: FormData, idempotencyKey?: string) =>
    request<T>('POST', path, fd, { isForm: true, idempotencyKey }),
};
