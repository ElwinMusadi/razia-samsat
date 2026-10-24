// Worker runtime secret (secret_text binding) for the Potensi NTT provider. It is absent from the generated
// wrangler types and from every local config, and must be present before Potensi can be used. The old
// POTENSI_ACCESS_CLIENT_* secrets are no longer read (Cloudflare Access left the Potensi host on 2026-10-24).
interface Env {
  /** Data Potensi API key `ptn_…` from the potensi-tarik website, sent as `Authorization: Bearer`. */
  POTENSI_API_KEY?: string;
}
