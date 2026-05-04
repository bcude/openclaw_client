import type { ImgHTMLAttributes } from 'react';
import { useAuthedBlobUrl } from '../hooks';

type AuthedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string | null;
};

/**
 * Drop-in `<img>` replacement that fetches its `src` with the user's
 * JWT when the URL points at our own API, then renders the response
 * as a same-origin object URL. Use it anywhere a model-controlled or
 * persisted asset URL might land in the DOM (markdown, attachments,
 * preview tiles).
 *
 * Pass-through behavior for non-API URLs and `blob:` / `data:` makes
 * this safe to drop in everywhere — no need to special-case
 * third-party images.
 */
export default function AuthedImage({ src, alt, ...rest }: AuthedImageProps) {
  const resolved = useAuthedBlobUrl(src ?? null);
  /* While loading we render the element with no src so the layout box
   * stays put and CSS like `max-width: 100%` keeps applying. The alt
   * text is whatever the caller supplied. */
  return <img src={resolved ?? undefined} alt={alt ?? ''} {...rest} />;
}
