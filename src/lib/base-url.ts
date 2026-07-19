/**
 * Public base URL for links in emails, checkout redirects, and PDFs.
 * A configured non-local APP_BASE_URL wins; otherwise fall back to the
 * request origin — which makes zero-config deploys (workers.dev, one-click)
 * emit correct links.
 */
export function resolveBaseUrl(
  configured: string | undefined,
  requestUrl: string,
  requestIsLocal = false
): string {
  const trimmed = (configured ?? '').trim().replace(/\/+$/, '');
  const url = new URL(requestUrl);
  const origin = url.origin;
  if (!trimmed) return origin;
  const isLocalHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  try {
    const cfgHost = new URL(trimmed).hostname;
    if (isLocalHost(cfgHost)) {
      // A leaked dev value on a request that genuinely came through the edge
      // (one-click deploys copying .dev.vars.example): trust the origin.
      // requestIsLocal must be cf-ray-based, NOT hostname-based — wrangler
      // dev emulates the configured route host in request.url.
      if (!requestIsLocal) return origin;
      // Local dev on a localhost URL: dev servers move between ports
      // (8787, 8788, …) and the request origin always carries the right one,
      // so it beats a pinned localhost value. When wrangler dev emulates a
      // production hostname, the configured localhost base still wins —
      // the request origin would point local links at production.
      if (isLocalHost(url.hostname)) return origin;
    }
  } catch {
    return origin; // unparseable configured value
  }
  return trimmed;
}
