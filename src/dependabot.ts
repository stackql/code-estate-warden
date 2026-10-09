import { READ_TOKEN_VAR } from "./stackql.ts";

export const http = {
  fetch: (url: string, options: RequestInit) => fetch(url, options),
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** The provider hides this endpoint's 204/404 status. This is the only direct GitHub read. */
export async function alerts(org: string, repo: string, admin = false): Promise<{ enabled: boolean | null; http_status: number; reason: string | null }> {
  const token = process.env[READ_TOKEN_VAR];
  if (!token) throw new Error(`${READ_TOKEN_VAR} is not set`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await http.fetch(`https://api.github.com/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/vulnerability-alerts`, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204) return { enabled: true, http_status: 204, reason: null };
    // GitHub uses 404 for disabled alerts AND hidden repositories. Confirm repository admin access.
    if (response.status === 404) {
      return { enabled: admin ? false : null, http_status: 404, reason: admin ? null : "disabled or inaccessible; repository admin permission is needed to distinguish" };
    }
    const message = response.status === 403 ? await response.text() : "";
    const limited = response.status === 429 || (response.status === 403 &&
      (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0" || /rate limit|abuse/i.test(message)));
    if (limited && attempt < 3) {
      const retry = Number(response.headers.get("retry-after") ?? 60) * 1000;
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000 - Date.now();
      await http.wait(Math.max(retry, reset, 1000));
      continue;
    }
    if (limited) throw new Error(`Dependabot alerts read for ${org}/${repo} exhausted rate-limit retries (HTTP ${response.status})`);
    if (response.status === 403) return { enabled: null, http_status: 403, reason: "permission denied" };
    throw new Error(`Dependabot alerts read for ${org}/${repo} failed with HTTP ${response.status}`);
  }
  throw new Error(`Dependabot alerts read for ${org}/${repo} exhausted retries`);
}
