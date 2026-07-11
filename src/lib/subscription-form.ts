export function toDateInputValue(
  date: Date,
  timezoneOffsetMinutes = date.getTimezoneOffset()
): string {
  return new Date(date.getTime() - timezoneOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
}

export function startDateForStatusTransition({
  currentStatus,
  nextStatus,
  currentStartDate,
  now = new Date(),
}: {
  currentStatus: string;
  nextStatus: string;
  currentStartDate: string;
  now?: Date;
}): string {
  return nextStatus === "active" && currentStatus !== "active"
    ? toDateInputValue(now)
    : currentStartDate;
}
