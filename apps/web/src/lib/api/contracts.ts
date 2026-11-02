export type DraftItem = { name: string | null; quantity: number | null; unit: string | null; unitPrice: string | null; lineTotal: string | null };
export type DraftIssue = { itemIndex: number | null; field: "name" | "quantity" | "unit" | "unitPrice" | null; code: string };
export type SalesDraft = { currency: "NGN"; requiresReview: boolean; items: DraftItem[]; totalAmount: string | null; issues: DraftIssue[] };
export type ProductRef = { id: string; canonicalName: string };
export type ProductMatch = { matched: boolean; matchType: "canonical" | "alias" | null; product: ProductRef | null };
export type ProductsPage = { products: ProductRef[]; nextCursor: string | null };
export type SalePayload = { items: { name: string; quantity: number; unit: string; unitPrice: string; productId?: string }[] };
export type Sale = { id: string; soldAt: string; totalAmount: string; items: { id: string; name: string; quantity: number; unit: string; unitPrice: string; lineTotal: string; productId?: string | null }[] };
export type SalesPage = { sales: Sale[]; nextCursor: string | null };
export type SalesSummary = { date: string; timeZone: "Africa/Lagos"; totalAmount: string; saleCount: number };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid API response.");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid API response.");
  return value;
}
export function productId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid product ID.");
  return value.toLowerCase();
}
export function parseProduct(value: unknown): ProductRef {
  const p = object(value);
  return { id: productId(p.id), canonicalName: text(p.canonicalName, 200) };
}
export function parseMatches(value: unknown, count: number): ProductMatch[] {
  const v = object(value);
  if (!Array.isArray(v.matches) || v.matches.length !== count) throw new Error("Invalid product matches.");
  return v.matches.map(value => {
    const match = object(value);
    if (match.matched === false && match.product === null && match.matchType === null) return { matched: false, product: null, matchType: null };
    if (match.matched !== true || !["canonical", "alias"].includes(String(match.matchType))) throw new Error("Invalid product match.");
    return { matched: true, product: parseProduct(match.product), matchType: match.matchType as "canonical" | "alias" };
  });
}
export function parseProductsPage(value: unknown): ProductsPage {
  const page = object(value);
  if (!Array.isArray(page.products) || page.products.length > 50) throw new Error("Invalid products list.");
  return { products: page.products.map(parseProduct), nextCursor: page.nextCursor === null ? null : productId(page.nextCursor) };
}
function money(value: unknown) {
  const result = text(value, 40);
  if (!/^\d{1,24}(?:\.\d{1,2})?$/.test(result)) throw new Error("Invalid API amount.");
  return result;
}
function quantity(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647) throw new Error("Invalid API quantity.");
  return value;
}
export function parseDraft(value: unknown): SalesDraft {
  const v = object(value);
  if (v.currency !== "NGN" || typeof v.requiresReview !== "boolean" || !Array.isArray(v.items) || v.items.length > 30 || !Array.isArray(v.issues) || v.issues.length > 200) throw new Error("Invalid extraction response.");
  const items = v.items.map(value => {
    const item = object(value);
    return { name: item.name === null ? null : text(item.name, 200), quantity: item.quantity === null ? null : quantity(item.quantity), unit: item.unit === null ? null : text(item.unit, 50), unitPrice: item.unitPrice === null ? null : money(item.unitPrice), lineTotal: item.lineTotal === null ? null : money(item.lineTotal) };
  });
  const issues = v.issues.map((value): DraftIssue => {
    const issue = object(value);
    if (issue.itemIndex !== null && (typeof issue.itemIndex !== "number" || !Number.isInteger(issue.itemIndex) || issue.itemIndex < 0 || issue.itemIndex >= items.length)) throw new Error("Invalid extraction issue.");
    if (issue.field !== null && issue.field !== "name" && issue.field !== "quantity" && issue.field !== "unit" && issue.field !== "unitPrice") throw new Error("Invalid extraction issue.");
    return { itemIndex: issue.itemIndex as number | null, field: issue.field, code: text(issue.code, 80) };
  });
  return { currency: "NGN", requiresReview: v.requiresReview, items, issues, totalAmount: v.totalAmount === null ? null : money(v.totalAmount) };
}
export function parseSale(value: unknown): Sale {
  const sale = object(value);
  const soldAt = text(sale.soldAt, 50);
  if (!Number.isFinite(Date.parse(soldAt)) || !Array.isArray(sale.items) || sale.items.length > 100) throw new Error("Invalid saved sale.");
  return { id: text(sale.id, 100), soldAt, totalAmount: money(sale.totalAmount), items: sale.items.map(value => {
    const item = object(value);
    return { id: text(item.id, 100), name: text(item.name, 200), quantity: quantity(item.quantity), unit: text(item.unit, 50), unitPrice: money(item.unitPrice), lineTotal: money(item.lineTotal), ...(item.productId !== undefined ? { productId: item.productId === null ? null : productId(item.productId) } : {}) };
  }) };
}
export function parseSalesPage(value: unknown): SalesPage {
  const v = object(value);
  if (!Array.isArray(v.sales) || v.sales.length > 50) throw new Error("Invalid sales list.");
  return { sales: v.sales.map(parseSale), nextCursor: v.nextCursor === null ? null : text(v.nextCursor, 100) };
}
export function parseSummary(value: unknown): SalesSummary {
  const v = object(value);
  if (v.timeZone !== "Africa/Lagos" || typeof v.saleCount !== "number" || !Number.isSafeInteger(v.saleCount) || v.saleCount < 0 || typeof v.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) throw new Error("Invalid sales summary.");
  return { date: v.date, timeZone: "Africa/Lagos", saleCount: v.saleCount, totalAmount: money(v.totalAmount) };
}
