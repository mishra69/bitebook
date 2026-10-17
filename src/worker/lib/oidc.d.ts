// Types for the skill-copied oidc.js (kept unmodified so sync-assets.sh can compare it).
export type Provider = { jwksUrl: string; issuers: string[] };
export const GOOGLE: Provider;
export const MICROSOFT: Provider;
export const APPLE: Provider;
export function verifyIdToken(
  idToken: string,
  opts: Provider & { audience: string; cacheTtl?: number; clockSkew?: number },
): Promise<Record<string, unknown> & { sub: string; iss: string; aud: string; exp: number }>;
