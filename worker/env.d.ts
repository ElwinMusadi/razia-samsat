// Worker runtime secrets (secret_text bindings) for the Potensi NTT provider. They are absent from the
// generated wrangler types and from every local config; both must be present before Potensi can be used.
interface Env {
  POTENSI_ACCESS_CLIENT_ID?: string;
  POTENSI_ACCESS_CLIENT_SECRET?: string;
}
