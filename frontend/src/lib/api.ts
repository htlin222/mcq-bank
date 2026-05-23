// Tiny typed fetch wrapper. Access cookie is sent automatically when on the
// real domain; for local dev, Vite proxy injects X-Dev-Email.

export class ApiError extends Error {
  constructor(public status: number, public data: any) {
    super(`API ${status}: ${JSON.stringify(data)}`);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: any,
  opts: { isForm?: boolean } = {}
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

  const res = await fetch(path, {
    method,
    headers,
    body: bodyPayload,
    credentials: 'include',
  });

  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get:   <T = any>(path: string) => request<T>('GET', path),
  post:  <T = any>(path: string, body?: any) => request<T>('POST', path, body),
  put:   <T = any>(path: string, body?: any) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body?: any) => request<T>('PATCH', path, body),
  del:   <T = any>(path: string) => request<T>('DELETE', path),
  upload:<T = any>(path: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<T>('POST', path, fd, { isForm: true });
  },
};
