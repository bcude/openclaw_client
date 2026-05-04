import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../api';

/**
 * Decide whether `url` points at our own API and therefore needs a JWT
 * to fetch. Anything else (third-party CDNs, `blob:`, `data:`, the
 * page's own static assets) is returned to the caller as-is so we
 * never accidentally leak the token to a foreign host.
 */
function isApiUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith(API_BASE_URL)) return true;
  if (url.startsWith('/api/')) return true;
  if (typeof window !== 'undefined' && url.startsWith(`${window.location.origin}/api/`)) return true;
  return false;
}

interface CachedBlob {
  url: string;
  resolved: string;
}

/**
 * Resolve `url` to something a `<img src>` or `<a href>` can use,
 * authenticating with the current JWT only when the URL points at our
 * own API.
 *
 *  - For API URLs: fetches with `Authorization: Bearer …`, builds an
 *    object URL from the response blob, and revokes it on unmount or
 *    when `url` changes.
 *  - For non-API URLs (blob/data/third-party): returned synchronously
 *    so the first paint is immediate and the effect can short-circuit.
 *  - Returns `null` while the API fetch is in flight; callers can
 *    render a skeleton (an empty string would render a broken-image
 *    icon instead).
 *
 * Replaces the older `?token=` query-string approach: the JWT now
 * never appears in any URL, access log, browser history, or
 * `Referer` header.
 */
export default function useAuthedBlobUrl(url: string | null | undefined): string | null {
  /* Cached async result, scoped to the URL it was fetched for so a
   * URL change immediately invalidates the previous blob in the
   * render output (no flash of stale content while the new fetch is
   * pending). The effect's cleanup revokes the object URL itself. */
  const [cached, setCached] = useState<CachedBlob | null>(null);

  useEffect(() => {
    if (!url) return undefined;
    if (url.startsWith('blob:') || url.startsWith('data:') || !isApiUrl(url)) return undefined;

    const token = localStorage.getItem('token');
    if (!token) return undefined;

    let cancelled = false;
    let createdBlobUrl: string | null = null;

    (async () => {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        createdBlobUrl = URL.createObjectURL(blob);
        setCached({ url, resolved: createdBlobUrl });
      } catch {
        /* swallow — caller treats `null` as the loading/failed state */
      }
    })();

    return () => {
      cancelled = true;
      /* Revoking a URL the browser is still rendering as `<img src>`
       * is harmless on every modern engine — the bitmap is already
       * decoded into memory at first paint. Keeping it past unmount
       * would just leak. */
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
    };
  }, [url]);

  /* Synchronous resolution covers the no-fetch cases. Computed fresh
   * on every render so the answer always tracks the current `url`
   * prop without going through state — keeps the effect free of
   * "setState in effect body" lint complaints. */
  if (!url) return null;
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (!isApiUrl(url)) return url;

  return cached && cached.url === url ? cached.resolved : null;
}
