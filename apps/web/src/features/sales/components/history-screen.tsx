"use client";

import { useState } from "react";
import { PageHeader, EmptyState } from "@/components/ui/presentation";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { useSalesList } from "../hooks/use-sales-data";
import { SalesList } from "./sales-list";

export function HistoryScreen() {
  const [cursors, setCursors] = useState<string[]>([]);
  const { data, loading, error, reload } = useSalesList(20, cursors.at(-1));
  return <><PageHeader eyebrow="YOUR BUSINESS, AT A GLANCE" title="Sales history" actions={<Button variant="ghost" onClick={reload} disabled={loading}><Icon name="refresh" />Refresh</Button>}><p>Your confirmed sales. Times shown in Lagos time.</p></PageHeader>
    {loading && <p role="status" className="muted">Loading sales…</p>}
    {error && <div className="feedback feedback--error" role="alert">{error}<Button variant="ghost" onClick={reload}>Retry</Button></div>}
    {!error && data && (data.sales.length ? <SalesList sales={data.sales} /> : <EmptyState icon={<Icon name="history" />} title="No sales on this page"><p>Your confirmed sales will appear here after you save them.</p></EmptyState>)}
    <div className="history-pagination"><Button variant="secondary" disabled={!cursors.length || loading} onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous</Button><span>Page {cursors.length + 1}</span><Button variant="secondary" disabled={!data?.nextCursor || loading || !!error} onClick={() => { const next = data?.nextCursor; if (next) setCursors(previous => [...previous, next]); }}>Next</Button></div>
  </>;
}
