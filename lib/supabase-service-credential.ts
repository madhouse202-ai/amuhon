/** Server-side Supabase API credentials. Do not import from client components. */
export type SupabaseServiceCredential = {
  apiKey: string;
  source: "secret";
};

type SupabaseServiceEnvironment = Record<string, string | undefined>;

/**
 * Require the new server-only secret key. Legacy service-role keys are not read.
 */
export function getSupabaseServiceCredential(
  env: SupabaseServiceEnvironment = process.env,
): SupabaseServiceCredential | null {
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!secretKey || secretKey !== secretKey.trim() || !/^sb_secret_[A-Za-z0-9_-]+$/.test(secretKey)) return null;
  return { apiKey: secretKey, source: "secret" };
}

/**
 * Supabase API keys belong in `apikey`. Service requests do not carry an
 * Authorization Bearer token or an end-user JWT.
 */
export function createSupabaseServiceHeaders(
  credential: SupabaseServiceCredential,
  initial?: HeadersInit,
): Headers {
  const headers = new Headers(initial);
  headers.set("apikey", credential.apiKey);
  headers.delete("authorization");
  return headers;
}

/**
 * supabase-js 2.118's general REST fetch adds the API key as a Bearer fallback.
 * Strip that header for this server-only service client while preserving the
 * SDK-generated apikey and all request method/body/options.
 */
export function createSupabaseServiceFetch(
  credential: SupabaseServiceCredential,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const serviceHeaders = createSupabaseServiceHeaders(credential, headers);
    return fetchImpl(input, { ...init, headers: serviceHeaders });
  };
}
