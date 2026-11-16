/** Public Supabase API-key selection shared by browser and cookie-backed Auth clients. */
export type SupabasePublicCredential = {
  apiKey: string;
};

/** The publishable key is required; legacy anon JWTs are no longer accepted. */
export function getSupabasePublicCredential(publishableKey: string | undefined): SupabasePublicCredential | null {
  if (!publishableKey || publishableKey !== publishableKey.trim() ||
      !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) return null;
  return { apiKey: publishableKey };
}

/**
 * supabase-js 2.118 uses the API key as an Authorization fallback when no user
 * session exists. Publishable keys are not JWTs, so remove only that exact
 * fallback. A signed-in user's Bearer JWT remains untouched.
 */
export function createSupabasePublicFetch(
  credential: SupabasePublicCredential,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));

    if (!headers.has("apikey")) headers.set("apikey", credential.apiKey);
    if (headers.get("authorization") === `Bearer ${credential.apiKey}`) {
      headers.delete("authorization");
    }

    return fetchImpl(input, { ...init, headers });
  };
}
