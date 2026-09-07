import { getAccessToken } from "@/lib/supabase/auth";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "/api/v1";
const NEXT_LOCAL_API_PREFIXES = ["/competitor-radar/"];

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiUrl(path: string): string {
  const base = NEXT_LOCAL_API_PREFIXES.some((prefix) => path.startsWith(prefix))
    ? "/api/v1"
    : API_BASE_URL;
  return `${base}${path}`;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
    return {};
  }

  const token = await getAccessToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message: string;
    try {
      const json = JSON.parse(body);
      message = json.detail || json.message || body;
    } catch {
      message = body || response.statusText;
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}

export const apiClient = {
  async get<T>(path: string): Promise<T> {
    const res = await fetch(apiUrl(path), {
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
    });
    return handleResponse<T>(res);
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(apiUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return handleResponse<T>(res);
  },

  async delete<T>(path: string): Promise<T> {
    const res = await fetch(apiUrl(path), {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
    });
    return handleResponse<T>(res);
  },

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const res = await fetch(apiUrl(path), {
      method: "POST",
      headers: {
        ...(await getAuthHeaders()),
      },
      body: formData,
    });
    return handleResponse<T>(res);
  },
};
