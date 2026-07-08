/**
 * Public base URL for links in emails, checkout redirects, and PDFs.
 * Configured APP_BASE_URL wins; otherwise fall back to the request origin —
 * which makes zero-config deploys (workers.dev, one-click) emit correct links.
 */
export function resolveBaseUrl(
  configured: string | undefined,
  requestUrl: string,
  requestIsLocal = false
): string {
  const trimmed = (configured ?? '').trim().replace(/\/+$/, '');
  const origin = new URL(requestUrl).origin;
  if (!trimmed) return origin;
  // A localhost base on a request that genuinely came through the edge is a
  // leaked dev value (one-click deploys copying .dev.vars.example) — trust the
  // origin instead. requestIsLocal must be cf-ray-based, NOT hostname-based:
  // wrangler dev emulates the configured route host in request.url, so a
  // local request can carry the production hostname.
  try {
    const cfgHost = new URL(trimmed).hostname;
    const isLocal = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    if (isLocal(cfgHost) && !requestIsLocal) return origin;
  } catch {
    return origin; // unparseable configured value
  }
  return trimmed;
}
