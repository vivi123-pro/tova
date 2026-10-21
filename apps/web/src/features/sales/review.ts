import type { SalePayload, SalesDraft } from "../../lib/api/contracts.ts";

export type ReviewRow = { id: string; name: string; quantity: string; unit: string; unitPrice: string };
export function draftRows(draft: SalesDraft): ReviewRow[] {
  return draft.items.map(item => ({ id: crypto.randomUUID(), name: item.name ?? "", quantity: item.quantity === null ? "" : String(item.quantity), unit: item.unit ?? "", unitPrice: item.unitPrice ?? "" }));
}
export function emptyRow(): ReviewRow { return { id: crypto.randomUUID(), name: "", quantity: "", unit: "", unitPrice: "" }; }
export function cents(value: string): bigint | null {
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return result > 0n && result <= 99999999999999n ? result : null;
}
export function decimal(value: bigint) { return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`; }
export function validateReview(rows: ReviewRow[]) {
  const errors: Partial<Record<"name" | "quantity" | "unit" | "unitPrice", string>>[] = [];
  const lineTotals: (string | null)[] = [];
  const items: SalePayload["items"] = [];
  let total = 0n;
  rows.forEach((row, i) => {
    const error: typeof errors[number] = {};
    if (!row.name.trim() || row.name.trim().length > 200) error.name = "Enter an item name (up to 200 characters).";
    if (!/^\d+$/.test(row.quantity) || Number(row.quantity) < 1 || Number(row.quantity) > 2147483647) error.quantity = "Enter a positive whole quantity.";
    if (!row.unit.trim() || row.unit.trim().length > 50) error.unit = "Enter the selling unit.";
    const price = cents(row.unitPrice);
    if (price === null) error.unitPrice = "Enter a positive price with up to 2 decimal places.";
    const line = price !== null && !error.quantity ? price * BigInt(row.quantity) : null;
    if (line !== null && line > 99999999999999n) error.unitPrice = "Line total is too large.";
    errors[i] = error;
    lineTotals.push(Object.keys(error).length || line === null ? null : decimal(line));
    if (!Object.keys(error).length && line !== null && price !== null) {
      total += line;
      items.push({ name: row.name.trim(), quantity: Number(row.quantity), unit: row.unit.trim(), unitPrice: decimal(price) });
    }
  });
  const formError = rows.length < 1 ? "Add at least one item." : rows.length > 100 ? "Use no more than 100 items." : total > 99999999999999n ? "The sale total is too large." : null;
  const valid = !formError && errors.every(error => !Object.keys(error).length);
  return { valid, errors, formError, lineTotals, totalAmount: valid ? decimal(total) : null, payload: valid ? { items } : null };
}
export function formatNgn(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return `₦${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}
