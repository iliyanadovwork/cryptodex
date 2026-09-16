/**
 * TEST-ONLY CREDENTIALS.
 *
 * config/index.js reads every secret from the environment - there are no
 * hardcoded fallbacks, because this repository is public and a fallback in
 * source is a published key. Unit tests still need the JWT and AES paths to
 * produce deterministic output, so obviously-fake values are injected here,
 * before the module registry is built.
 *
 * These are not secrets and must never be used anywhere but jest. Anything
 * already set in the environment wins, so a real local.env is not overridden.
 */
const TEST_DEFAULTS = {
  SECRET_KEY: "test-only-jwt-signing-key-not-a-real-secret",
  CRYPTO_SECRET_KEY: "test-only-aes-key-not-a-real-secret",
  GATEWAY_AUTH_TOKEN: "test-only-gateway-token",
  GATEWAY_ENCRYPT_KEY: "test-only-encrypt-key",
  GATEWAY_IV: "test-only-iv-0000",
  GATEWAY_API_KEY: "test-only-api-key",
  GATEWAY_API_SECRET: "test-only-api-secret",
  ETH_WALLET_ID: "00000000-0000-0000-0000-000000000000",
  BNB_WALLET_ID: "00000000-0000-0000-0000-000000000000",
};

for (const [name, value] of Object.entries(TEST_DEFAULTS)) {
  if (!process.env[name]) process.env[name] = value;
}
