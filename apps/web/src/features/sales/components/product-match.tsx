"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { api } from "@/lib/api/client";
import type { ProductRef } from "@/lib/api/contracts";
import type { ReviewRow } from "../review";
import type { createSalesFlow } from "../sales-flow";

export function ProductMatch({ row, flow, locked }: { row: ReviewRow; flow: ReturnType<typeof createSalesFlow>; locked: boolean }) {
  const [products, setProducts] = useState<ProductRef[]>([]);
  const [mode, setMode] = useState<"idle" | "create" | "existing">("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [lastCursor, setLastCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<"create" | "link" | null>(null);
  const [canonicalName, setCanonicalName] = useState(row.name);
  const [creationConfirmed, setCreationConfirmed] = useState(false);
  const differentName = canonicalName.trim() !== row.name.trim();
  const selection = row.catalogue;
  const product = products.find(product => product.id === selected);
  async function loadProducts(next?: string) {
    if (loading) return;
    setMode("existing"); setLoading(true); setError(null); setLastCursor(next);
    try {
      const page = await api.products(next);
      setProducts(previous => next ? [...new Map([...previous, ...page.products].map(p => [p.id, p])).values()] : page.products);
      setCursor(page.nextCursor);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to load products."); }
    finally { setLoading(false); }
  }
  async function addProduct() {
    setPending("create");
    try { await flow.createRowProduct(row.id, canonicalName, creationConfirmed); }
    finally { setPending(null); }
  }
  async function linkProduct() {
    if (!product) return;
    setPending("link");
    try { await flow.confirmRowAlias(row.id, product, confirmed); }
    finally { setPending(null); }
  }
  if (!selection) return null; // A retained legacy save can have no product reference.
  if (selection.status === "matched" && selection.product) return <div className="product-match product-match--matched" role="status"><Icon name="check" width="16" height="16" /><span>Matched to <strong>{selection.product.canonicalName}</strong></span></div>;
  if (selection.status === "loading") return <div className="product-match product-match--loading" role="status" aria-busy="true"><span className="spinner" aria-hidden="true" />{pending === "create" ? "Adding product…" : pending === "link" ? "Linking product…" : "Matching product…"}</div>;
  return <div className="product-match">
    {mode === "idle" && <div className="product-match__summary">
      <span className="product-match__hint">{selection.status === "unchecked" ? "Check this product" : "New to your catalogue"}</span>
      <div className="product-actions">
        <Button disabled={locked || !row.name.trim() || row.name.trim().length > 200 || selection.status === "unchecked"} aria-expanded={false} aria-controls={`${row.id}-catalogue-choice`} onClick={() => setMode("create")}>Add to catalogue</Button>
        <Button variant="ghost" disabled={locked || !row.name.trim()} aria-expanded={false} aria-controls={`${row.id}-catalogue-choice`} onClick={() => void loadProducts()}>Use existing<Icon name="arrow" width="16" height="16" /></Button>
      </div>
    </div>}
    {selection.error && <p className="product-match__error" role="alert">{selection.error}</p>}
    {(selection.status === "error" || selection.status === "unchecked") && <Button variant="ghost" className="product-retry" disabled={locked || !row.name.trim()} onClick={() => void flow.resolveRows(row.id)}><Icon name="refresh" width="16" height="16" />{selection.status === "error" ? "Retry matching" : "Check match"}</Button>}
    {mode !== "idle" && <div className="product-choice" id={`${row.id}-catalogue-choice`}>
      <div className="product-choice__heading"><h3>{mode === "create" ? "Add to catalogue" : "Use existing product"}</h3><Button variant="ghost" disabled={locked || loading} onClick={() => setMode("idle")}>Cancel</Button></div>
    {mode === "create" && <>
      <div className="form-field"><label htmlFor={`${row.id}-canonical`}>Product name</label><input id={`${row.id}-canonical`} value={canonicalName} disabled={locked} maxLength={200} onChange={event => { setCanonicalName(event.target.value); setCreationConfirmed(false); }} /></div>
      {differentName && <label className="review-check"><input type="checkbox" checked={creationConfirmed} disabled={locked} onChange={event => setCreationConfirmed(event.target.checked)} /><span>“{row.name}” is the same product as “{canonicalName.trim()}”.</span></label>}
      <Button className="product-choice__submit" disabled={locked || !canonicalName.trim() || (differentName && !creationConfirmed)} onClick={() => void addProduct()}>Add product</Button>
    </>}
    {mode === "existing" && <>
      <div className="form-field"><label htmlFor={`${row.id}-product`}>Product</label><select id={`${row.id}-product`} value={selected} disabled={locked || loading} onChange={event => { setSelected(event.target.value); setConfirmed(false); }}><option value="">Select a product</option>{products.map(product => <option key={product.id} value={product.id}>{product.canonicalName}</option>)}</select></div>
      {loading && <p className="product-match__hint" role="status">Loading products…</p>}
      {error && <div className="product-match__error" role="alert"><p>{error}</p><Button variant="ghost" disabled={locked || loading} onClick={() => void loadProducts(lastCursor)}>Try again</Button></div>}
      {!loading && !error && products.length === 0 && <p className="product-match__hint">No products yet. <Button variant="ghost" disabled={locked} onClick={() => setMode("create")}>Add to catalogue</Button></p>}
      {cursor && !error && <Button variant="ghost" className="product-choice__more" disabled={locked || loading} onClick={() => void loadProducts(cursor)}>Load more</Button>}
      {product && <>
        <label className="review-check"><input type="checkbox" checked={confirmed} disabled={locked || loading} onChange={event => setConfirmed(event.target.checked)} /><span>“{row.name}” is the same product as “{product.canonicalName}”.</span></label>
        <Button className="product-choice__submit" disabled={locked || loading || !confirmed} onClick={() => void linkProduct()}>Use this product</Button>
      </>}
    </>}
    </div>}
  </div>;
}
