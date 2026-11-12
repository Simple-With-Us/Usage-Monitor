import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/ingest-auth";
import { prisma } from "@/lib/prisma";
import { OWNER_EXPENSE_SOURCE_APP } from "@/lib/owner-expense";
import { eventsFromOwnerExpenseRows, renderBillsCalendar } from "@/lib/bills-calendar";

function calendarToken(): string | null {
  const token = process.env.BILLS_CALENDAR_TOKEN?.trim();
  return token && token.length >= 32 ? token : null;
}

export async function GET(request: NextRequest) {
  const expected = calendarToken();
  if (!expected) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const provided = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  if (!provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await prisma.externalUsageEvent.findMany({
    where: { sourceApp: OWNER_EXPENSE_SOURCE_APP },
    orderBy: { occurredAt: "asc" },
    take: 500,
    select: {
      id: true,
      provider: true,
      service: true,
      label: true,
      costUsd: true,
      occurredAt: true,
      metadata: true,
    },
  });
  const body = renderBillsCalendar(eventsFromOwnerExpenseRows(rows));
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": 'inline; filename="bills.ics"',
    },
  });
}
