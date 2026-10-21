import type { Sale } from "@/lib/api/contracts";
import { formatNgn } from "../review";

const dateFormat = new Intl.DateTimeFormat("en-NG", { timeZone: "Africa/Lagos", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function SalesList({ sales }: { sales: Sale[] }) {
  return <ul className="sales-list">{sales.map(sale => <li key={sale.id}><div><h3>{sale.items.slice(0, 3).map(item => `${item.quantity} ${item.unit} · ${item.name}`).join(", ")}{sale.items.length > 3 ? ` +${sale.items.length - 3} more` : ""}</h3><p><time dateTime={sale.soldAt}>{dateFormat.format(new Date(sale.soldAt))}</time> · Confirmed</p></div><strong>{formatNgn(sale.totalAmount)}</strong></li>)}</ul>;
}
