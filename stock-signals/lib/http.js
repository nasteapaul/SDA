// Small fetch wrapper: timeout, status check, text or JSON.
export async function get(url, { headers = {}, timeout = 15000, json = false, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return json ? res.json() : res.text();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
