// Errors carry the status and Agentic RAG's `detail`, never a credential or a query string
// (ephemeral tokens travel as ?eph-token=).

export class ParError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly detail: unknown;

  constructor(method: string, url: string, status: number, detail: unknown) {
    const path = withoutQuery(url);
    super(`${method} ${path} → ${status}${summarize(detail)}`);
    this.name = "ParError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.detail = detail;
  }
}

function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

// FastAPI-style bodies: {"detail": "..."} or {"detail": [{"loc": [...], "msg": "..."}]}.
function summarize(body: unknown): string {
  if (body == null || body === "") return "";
  if (typeof body === "string") return `: ${body.slice(0, 200)}`;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return `: ${detail.slice(0, 200)}`;
  if (Array.isArray(detail)) {
    const parts = detail.map((d: { loc?: unknown[]; msg?: string }) => `${d.loc?.join(".") ?? ""} ${d.msg ?? ""}`.trim());
    return `: ${parts.join("; ").slice(0, 300)}`;
  }
  return "";
}
