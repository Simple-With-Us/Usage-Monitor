import { canonicalProviderKey } from "@/lib/provider-identity";

export interface ProviderFinancialSemantics {
  balanceLabel: string;
  creditsLabel: string;
  includeBalanceInPortfolio: boolean;
}

const DEFAULT_SEMANTICS: ProviderFinancialSemantics = {
  balanceLabel: "account balance",
  creditsLabel: "credits",
  includeBalanceInPortfolio: false,
};

const PROVIDER_SEMANTICS: Readonly<Record<string, ProviderFinancialSemantics>> = {
  openai: {
    balanceLabel: "available API funds / limit",
    creditsLabel: "API credits",
    // OpenAI's fallback balance is remaining monthly spend limit, not cash.
    includeBalanceInPortfolio: false,
  },
  openrouter: {
    balanceLabel: "prepaid remaining",
    creditsLabel: "purchased credits",
    includeBalanceInPortfolio: true,
  },
  deepseek: {
    balanceLabel: "prepaid balance",
    creditsLabel: "granted credits",
    includeBalanceInPortfolio: true,
  },
  xai: {
    balanceLabel: "prepaid balance",
    creditsLabel: "API credits",
    includeBalanceInPortfolio: true,
  },
  twilio: {
    balanceLabel: "account balance",
    creditsLabel: "credits",
    includeBalanceInPortfolio: false,
  },
  tradier: {
    balanceLabel: "brokerage equity",
    creditsLabel: "API requests remaining",
    includeBalanceInPortfolio: false,
  },
  alpaca: {
    balanceLabel: "brokerage equity",
    creditsLabel: "API requests remaining",
    includeBalanceInPortfolio: false,
  },
  robinhood: {
    balanceLabel: "brokerage equity",
    creditsLabel: "API requests remaining",
    includeBalanceInPortfolio: false,
  },
  stripe: {
    balanceLabel: "merchant funds",
    creditsLabel: "credits",
    includeBalanceInPortfolio: false,
  },
};

export function providerFinancialSemantics(
  providerName: string
): ProviderFinancialSemantics {
  return PROVIDER_SEMANTICS[canonicalProviderKey(providerName)] ?? DEFAULT_SEMANTICS;
}

interface ProviderBalanceCandidate {
  name: string;
  groupId: string | null;
  latestSnapshot: { balance: number | null } | null;
}

export function sumProviderFunds(providers: ProviderBalanceCandidate[]): number {
  const seenGroups = new Set<string>();

  return providers.reduce((sum, provider) => {
    if (!providerFinancialSemantics(provider.name).includeBalanceInPortfolio) {
      return sum;
    }

    if (!provider.groupId) {
      return sum + (provider.latestSnapshot?.balance ?? 0);
    }

    if (seenGroups.has(provider.groupId)) {
      return sum;
    }
    seenGroups.add(provider.groupId);

    const groupCandidates = providers.filter(
      (candidate) =>
        candidate.groupId === provider.groupId &&
        providerFinancialSemantics(candidate.name).includeBalanceInPortfolio &&
        candidate.latestSnapshot?.balance != null
    );
    // A family group is not proof that multiple keys share one funded account.
    // Exclude ambiguous groups instead of dropping or multiplying money.
    if (groupCandidates.length !== 1) {
      return sum;
    }

    const groupBalance = groupCandidates[0]?.latestSnapshot?.balance;

    return sum + (groupBalance ?? 0);
  }, 0);
}
