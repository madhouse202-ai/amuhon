/**
 * Keep Supabase's signed-upload capability opaque and pass it unchanged to
 * tus-js-client. The public project key is a separate gateway header.
 */
export function tusEndpoint(projectUrl: URL): string {
  if (projectUrl.hostname.endsWith(".supabase.co")) {
    const projectRef = projectUrl.hostname.slice(0, -".supabase.co".length);
    return `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable/sign`;
  }
  return `${projectUrl.origin}/storage/v1/upload/resumable/sign`;
}

export function createOrderTusHeaders(publicApiKey: string, signedUploadToken: string) {
  if (!publicApiKey || !signedUploadToken) {
    throw new Error("TUS upload credentials are missing.");
  }

  return {
    apikey: publicApiKey,
    "x-signature": signedUploadToken,
  };
}

/** Diagnostic helpers intentionally return booleans only; never return credentials or derived hashes. */
export function inspectOrderTusCredentials(
  expectedSignature: string,
  requestSignature: string | undefined,
  expectedApiKey: string,
  requestApiKey: string | undefined,
) {
  return {
    signatureMatches: Boolean(requestSignature) && requestSignature === expectedSignature,
    signaturePresent: Boolean(requestSignature),
    signatureHasThreeParts: typeof requestSignature === "string" &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(requestSignature),
    apiKeyMatches: Boolean(requestApiKey) && requestApiKey === expectedApiKey,
  };
}

function supabaseProjectIdentity(url: URL): string | null {
  if (url.hostname.endsWith(".storage.supabase.co")) {
    return url.hostname.slice(0, -".storage.supabase.co".length);
  }
  if (url.hostname.endsWith(".supabase.co")) {
    return url.hostname.slice(0, -".supabase.co".length);
  }
  return null;
}

export function isOrderTusProjectMatch(supabaseUrl: string, tusEndpoint: string): boolean {
  try {
    const signer = new URL(supabaseUrl);
    const tus = new URL(tusEndpoint);
    const signerProject = supabaseProjectIdentity(signer);
    const tusProject = supabaseProjectIdentity(tus);
    if (signerProject && tusProject) return signerProject === tusProject;
    return signer.origin === tus.origin;
  } catch {
    return false;
  }
}
