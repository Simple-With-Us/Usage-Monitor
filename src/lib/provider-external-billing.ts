import { AdapterError, type AdapterExternalBillingSync } from "@/lib/adapters/helpers";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

type BillingDb = Prisma.TransactionClient | typeof prisma;

function cleanRequired(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 255) {
    throw new AdapterError(`External billing ${field} is invalid`, {
      code: "INVALID_RESPONSE",
    });
  }
  return cleaned;
}

function cleanOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, 255) : null;
}

function cleanNumber(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) {
    throw new AdapterError(`External billing ${field} is invalid`, {
      code: "INVALID_RESPONSE",
    });
  }
  return value;
}

function cleanDate(value: string | null | undefined, field: string): Date | null {
  if (value == null || value.trim() === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AdapterError(`External billing ${field} is invalid`, {
      code: "INVALID_RESPONSE",
    });
  }
  return date;
}

/**
 * Reconcile authoritative provider-side billing state without creating a
 * charge. Repeating the same sync only updates the existing composite-keyed
 * rows, and a complete sync prunes records that the provider no longer
 * returns.
 */
export async function reconcileProviderExternalBilling(
  providerId: string,
  sync: AdapterExternalBillingSync,
  db: BillingDb = prisma
): Promise<void> {
  const source = cleanRequired(sync.source, "source");
  const syncedAt = new Date();
  const seenIds = new Set<string>();

  for (const record of sync.records) {
    const externalId = cleanRequired(record.externalId, "externalId");
    if (seenIds.has(externalId)) {
      throw new AdapterError("External billing response contains duplicate IDs", {
        code: "INVALID_RESPONSE",
      });
    }
    seenIds.add(externalId);

    const data = {
      kind: cleanRequired(record.kind, "kind"),
      planName: cleanOptional(record.planName),
      status: cleanOptional(record.status),
      amountUsd: cleanNumber(record.amountUsd, "amountUsd"),
      currency: cleanOptional(record.currency)?.toUpperCase() ?? null,
      billingInterval: cleanOptional(record.billingInterval),
      currentPeriodStart: cleanDate(record.currentPeriodStart, "currentPeriodStart"),
      currentPeriodEnd: cleanDate(record.currentPeriodEnd, "currentPeriodEnd"),
      nextRenewalAt: cleanDate(record.nextRenewalAt, "nextRenewalAt"),
      requestLimit: cleanNumber(record.requestLimit, "requestLimit"),
      requestLimitWindow: cleanOptional(record.requestLimitWindow),
      spendLimitUsd: cleanNumber(record.spendLimitUsd, "spendLimitUsd"),
      spendLimitWindow: cleanOptional(record.spendLimitWindow),
      syncedAt,
    };

    await db.providerExternalBilling.upsert({
      where: {
        providerId_source_externalId: { providerId, source, externalId },
      },
      create: { providerId, source, externalId, ...data },
      update: data,
    });
  }

  if (!sync.authoritative) return;

  const externalIds = [...seenIds];
  await db.providerExternalBilling.deleteMany({
    where: {
      providerId,
      source,
      ...(externalIds.length > 0 ? { externalId: { notIn: externalIds } } : {}),
    },
  });
}
