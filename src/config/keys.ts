import type { ProviderConfig } from "./schema";

export function resolveApiKey(provider: ProviderConfig): string {
  if (provider.apiKeyEnv) {
    const value = process.env[provider.apiKeyEnv];
    if (value) return value;
  }
  if (provider.apiKey) return provider.apiKey;
  const hint = provider.apiKeyEnv
    ? `set the ${provider.apiKeyEnv} environment variable or the apiKey field`
    : "set the apiKey field";
  throw new Error(`No API key found for provider "${provider.name}": ${hint} in your config.toml`);
}
