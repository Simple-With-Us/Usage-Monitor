export type CredentialAction = "preserve" | "replace" | "clear";

export interface SecretCredentialOperation {
  path: string[];
  action: CredentialAction;
  value?: string;
}

export function credentialPathKey(path: string[]): string {
  return JSON.stringify(path);
}

export function buildProviderCredentialUpdate(input: {
  editing: boolean;
  apiKeyAction: CredentialAction;
  apiKey: string;
  secretPaths: string[][];
  secretActions: Record<string, CredentialAction>;
  secretValues: Record<string, string>;
}): {
  apiKey?: string;
  apiKeyAction?: CredentialAction;
  secretConfigOperations?: SecretCredentialOperation[];
} {
  const apiKey = input.apiKey.trim();
  if (!input.editing) return { apiKey: apiKey || undefined };
  if (input.apiKeyAction === "replace" && !apiKey) {
    throw new Error("Enter a replacement API key");
  }

  const secretConfigOperations = input.secretPaths.map((path) => {
    const key = credentialPathKey(path);
    const action = input.secretActions[key] ?? "preserve";
    if (action !== "replace") return { path, action };
    const value = (input.secretValues[key] ?? "").trim();
    if (!value) {
      throw new Error(`Enter a replacement value for ${path.join(".")}`);
    }
    return { path, action, value };
  });

  return {
    apiKeyAction: input.apiKeyAction,
    apiKey: input.apiKeyAction === "replace" ? apiKey : undefined,
    secretConfigOperations:
      secretConfigOperations.length > 0 ? secretConfigOperations : undefined,
  };
}
