export function calculateEomForecast(
  spentUsd: number,
  fixedAccruedUsd: number,
  now: Date
): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  
  // Calculate precise fractional day of the month for more accurate forecasting early in the month
  const currentDay = now.getUTCDate() + (now.getUTCHours() / 24) + (now.getUTCMinutes() / 1440);
  
  // Avoid division by zero at the exact start of the month
  if (currentDay < 0.1) {
    return spentUsd; 
  }

  // The usage portion is what grows linearly. Fixed costs don't grow.
  const usageUsd = Math.max(0, spentUsd - fixedAccruedUsd);
  const forecastedUsage = (usageUsd / currentDay) * daysInMonth;

  return fixedAccruedUsd + forecastedUsage;
}
