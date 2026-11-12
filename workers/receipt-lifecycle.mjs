export const RECEIPT_RETENTION_DAYS = 180;
export const RECEIPT_LIFECYCLE_MAX_AGE_SECONDS = RECEIPT_RETENTION_DAYS * 24 * 60 * 60;

export function validateReceiptLifecycleRules(rules) {
  if (!Array.isArray(rules)) return false;
  const relevant = rules.filter((rule) => {
    const prefix = rule?.conditions?.prefix;
    const transition = rule?.deleteObjectsTransition?.condition;
    return rule?.enabled === true
      && typeof prefix === "string"
      && ("evidence/".startsWith(prefix) || prefix.startsWith("evidence/"))
      && transition !== undefined;
  });
  if (relevant.length !== 1) return false;
  const [rule] = relevant;
  return rule.id === "receipt-retention"
    && rule.conditions?.prefix === "evidence/"
    && rule.deleteObjectsTransition?.condition?.type === "Age"
    && rule.deleteObjectsTransition.condition.maxAge === RECEIPT_LIFECYCLE_MAX_AGE_SECONDS;
}
