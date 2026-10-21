"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/presentation";
import { useSalesList, useSalesSummary } from "../hooks/use-sales-data";
import { formatNgn } from "../review";
import { SalesList } from "./sales-list";

export function SalesSummary() {
  const { data, loading, error, reload } = useSalesSummary();
  return <section className="sales-summary" aria-label="Today's sales overview" aria-busy={loading}>
    <div><p className="eyebrow">Today&apos;s sales</p><p className="stat-value">{data ? formatNgn(data.totalAmount) : "—"}</p></div>
    <div><p className="eyebrow">Sales recorded</p><p className="stat-value">{data?.saleCount ?? "—"}</p></div>
    <div className="summary-note">{error ? <p role="alert">{error} <Button variant="ghost" onClick={reload}>Retry</Button></p> : loading ? <span role="status">Updating your overview...</span> : "Today's totals · Africa/Lagos"}</div>
  </section>;
}
export function RecentSales() {
  const { data, loading, error, reload } = useSalesList(5);
  return <section className="recent-sales" aria-labelledby="recent-sales-title">
    <div className="section-heading"><h2 id="recent-sales-title">Recent sales</h2><Link href="/history" className="text-link">View history <Icon name="arrow" width="16" height="16" /></Link></div>
    {loading && <p className="muted" role="status">Loading recent sales...</p>}
    {error && <p className="feedback feedback--error" role="alert">{error} <Button variant="ghost" onClick={reload}>Retry</Button></p>}
    {data && !error && (data.sales.length ? <SalesList sales={data.sales} /> : <EmptyState icon={<Icon name="bag" />} title="A fresh page for your sales"><p>No confirmed sales yet. Your next saved sale will appear here.</p></EmptyState>)}
  </section>;
}
