export type SafeError = {
  code: string;
  message: string;
  request_id?: string;
};

export class ApiError extends Error {
  code: string;
  requestId = "";

  constructor(error: SafeError) {
    super(error.message);
    this.name = "ApiError";
    this.code = error.code;
    this.requestId = error.request_id || "";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || (payload && payload.ok === false)) {
    throw new ApiError(payload?.error || {
      code: "REQUEST_FAILED",
      message: "That did not work. Try again."
    });
  }
  return payload as T;
}
