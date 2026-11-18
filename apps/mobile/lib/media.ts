import { getBaseUrl } from "./api-url";
import { getSessionCookie } from "./auth";

/**
 * An <Image source> for a media URL. With the local storage driver the URL
 * is a path on our API (/api/media/blob?key=…) that needs the session
 * cookie, which React Native will not attach by itself; with S3 it is a
 * presigned absolute URL that needs nothing.
 */
export function mediaSource(url: string): {
  uri: string;
  headers?: Record<string, string>;
} {
  if (!url.startsWith("/")) return { uri: url };
  const cookie = getSessionCookie();
  return {
    uri: `${getBaseUrl()}${url}`,
    ...(cookie ? { headers: { Cookie: cookie } } : {}),
  };
}
