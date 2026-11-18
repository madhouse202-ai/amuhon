const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type LocalDevelopmentOriginResult =
  | { origin: string; failureCode: null }
  | { origin: null; failureCode: "LOCAL_REQUEST_URL_REJECTED" | "LOCAL_ORIGIN_HEADER_REJECTED" | "LOCAL_ORIGIN_MISMATCH" | "LOCAL_HOST_HEADER_MISMATCH" | "LOCAL_ROUTE_PATH_REJECTED" };

/** Accept only a same-origin HTTP request addressed to this exact development route on loopback. */
export function inspectLocalDevelopmentOrigin(
  request: Pick<Request, "url" | "headers">,
  expectedPath: string,
): LocalDevelopmentOriginResult {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return { origin: null, failureCode: "LOCAL_REQUEST_URL_REJECTED" };
  }

  const hostname = requestUrl.hostname.toLowerCase();
  if (requestUrl.protocol !== "http:" || !LOOPBACK_HOSTS.has(hostname) || !requestUrl.port ||
      requestUrl.username || requestUrl.password || requestUrl.search || requestUrl.hash) {
    return { origin: null, failureCode: "LOCAL_REQUEST_URL_REJECTED" };
  }
  if (requestUrl.pathname !== expectedPath) return { origin: null, failureCode: "LOCAL_ROUTE_PATH_REJECTED" };

  let originUrl: URL;
  try {
    const originHeader = request.headers.get("origin");
    if (!originHeader) return { origin: null, failureCode: "LOCAL_ORIGIN_HEADER_REJECTED" };
    originUrl = new URL(originHeader);
  } catch {
    return { origin: null, failureCode: "LOCAL_ORIGIN_HEADER_REJECTED" };
  }
  const originHostname = originUrl.hostname.toLowerCase();
  if (originUrl.protocol !== "http:" || !LOOPBACK_HOSTS.has(originHostname) || !originUrl.port ||
      originUrl.username || originUrl.password || originUrl.pathname !== "/" || originUrl.search || originUrl.hash) {
    return { origin: null, failureCode: "LOCAL_ORIGIN_HEADER_REJECTED" };
  }
  if (originUrl.origin !== requestUrl.origin) return { origin: null, failureCode: "LOCAL_ORIGIN_MISMATCH" };
  const hostHeader = request.headers.get("host")?.toLowerCase();
  if (!hostHeader || hostHeader !== requestUrl.host.toLowerCase()) {
    return { origin: null, failureCode: "LOCAL_HOST_HEADER_MISMATCH" };
  }
  return { origin: requestUrl.origin, failureCode: null };
}

export function getLocalDevelopmentOrigin(
  request: Pick<Request, "url" | "headers">,
  expectedPath: string,
): string | null {
  const result = inspectLocalDevelopmentOrigin(request, expectedPath);
  return result.failureCode === null ? result.origin : null;
}
