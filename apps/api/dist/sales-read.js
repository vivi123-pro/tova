export function businessDay(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (name) => parts.find(p => p.type === name)?.value ?? "";
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    // Nigeria uses UTC+01:00 year-round; never use the host's local timezone.
    const start = new Date(`${date}T00:00:00+01:00`);
    return { date, start, end: new Date(start.getTime() + 86_400_000) };
}
export async function salesSummary(db, now) {
    const { date, start, end } = businessDay(now);
    const result = await db.sale.aggregate({ where: { soldAt: { gte: start, lt: end } }, _sum: { totalAmount: true }, _count: { _all: true } });
    return { date, timeZone: "Africa/Lagos", totalAmount: result._sum.totalAmount?.toFixed(2) ?? "0.00", saleCount: result._count._all };
}
