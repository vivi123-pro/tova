"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, IconButton, buttonClassName } from "@/components/ui/button";
import { Card, PageHeader, EmptyState } from "@/components/ui/presentation";
import { Icon } from "@/components/ui/icon";
import { emptyRow, formatNgn, validateReview, type ReviewRow } from "../review";
import { useSalesSession } from "./sales-session";

export function ReviewScreen() {
  const { state, flow, recorder } = useSalesSession();
  const [acknowledged, setAcknowledged] = useState(false);
  const router = useRouter();
  const checked = validateReview(state.rows);
  const locked = !!state.attempt;
  const busy = state.phase === "saving";
  const update = (id: string, field: keyof Omit<ReviewRow, "id">, value: string) => flow.updateRows(state.rows.map(row => row.id === id ? { ...row, [field]: value } : row));
  if (state.phase === "saved" && state.savedSale) return <>
    <PageHeader eyebrow="ONE LESS THING TO REMEMBER" title="Sale saved"><p>Your confirmed sale is safely recorded.</p></PageHeader>
    <Card className="review-success"><Icon name="check" width="40" height="40" /><h2>{formatNgn(state.savedSale.totalAmount)}</h2><p>{state.savedSale.items.length} item lines saved.</p><p className="preview-note">Sale ID: {state.savedSale.id}</p><div className="recorder-actions"><Link href="/history" className={buttonClassName("secondary")}>View history</Link><Button onClick={() => { flow.reset(); recorder.cancel(); router.push("/record"); }}>Record another sale</Button></div></Card>
  </>;
  if (!state.draft) return <><PageHeader title="Review your sale" /><EmptyState icon={<Icon name="bag" />} title={state.phase === "extracting" ? "Preparing your draft…" : "No draft ready yet"}><p>{state.error ?? "Record a sale to get started."}</p>{state.transcript && state.phase === "error" ? <Button onClick={() => void flow.process(new Blob())}>Retry extraction</Button> : <Link href="/record" className="text-link">Go to recording <Icon name="arrow" /></Link>}</EmptyState></>;
  return <>
    <PageHeader eyebrow="A QUICK CHECK BEFORE IT’S SAVED" title="Review your sale"><p>Make it yours. Check each item, selling unit, and price.</p></PageHeader>
    <div className="review-notice" role="note"><strong>This is an unsaved draft.</strong> Please review every item before confirming. Prices are per selected selling unit; dozens stay dozens.</div>
    {state.draft.issues.length > 0 && <details className="extraction-issues" open><summary>Some details need your attention ({state.draft.issues.length})</summary><ul>{state.draft.issues.map((issue, i) => <li key={i}>{issue.itemIndex === null ? "Original transcript" : `Original item ${issue.itemIndex + 1}`}{issue.field ? ` · ${issue.field === "unitPrice" ? "unit price" : issue.field}` : ""}: {issue.code === "amount_out_of_range" ? "amount exceeds the supported limit" : "missing, uncertain, or unverified — check against the transcript"}.</li>)}</ul><p>These are the original extraction warnings. Correct the fields below and confirm that you have reviewed them.</p></details>}
    <details className="transcript"><summary>Original transcript</summary><p>{state.transcript}</p></details>
    <form onSubmit={event => { event.preventDefault(); if ((acknowledged || locked) && checked.valid) void flow.save(); }}>
      <div className="review-items">{state.rows.map((row, index) => <Card key={row.id} className="review-item">
        <div className="section-heading"><h2>Item {index + 1}</h2><IconButton variant="ghost" label={`Remove item ${index + 1}`} disabled={locked} onClick={() => flow.updateRows(state.rows.filter(item => item.id !== row.id))}><Icon name="close" /></IconButton></div>
        <div className="review-fields">{([['name', 'Item name'], ['quantity', 'Quantity'], ['unit', 'Selling unit'], ['unitPrice', 'Price per unit (NGN)']] as const).map(([field, label]) => <div key={field} className={`form-field field-${field}`}>
          <label htmlFor={`${row.id}-${field}`}>{label}</label><input id={`${row.id}-${field}`} value={row[field]} onChange={event => update(row.id, field, event.target.value)} disabled={locked} required inputMode={field === "quantity" ? "numeric" : field === "unitPrice" ? "decimal" : "text"} maxLength={field === "name" ? 200 : field === "unit" ? 50 : 30} list={field === "unit" ? "selling-units" : undefined} aria-invalid={!!checked.errors[index]?.[field]} aria-describedby={checked.errors[index]?.[field] ? `${row.id}-${field}-error` : undefined} />
          {checked.errors[index]?.[field] && <span className="field-error" id={`${row.id}-${field}-error`}>{checked.errors[index][field]}</span>}
        </div>)}</div>
        <p className="line-total">Line total <strong>{checked.lineTotals[index] ? formatNgn(checked.lineTotals[index]) : "Complete the item to calculate"}</strong></p>
      </Card>)}</div>
      <datalist id="selling-units">{["piece", "dozen", "pair", "pack", "bundle", "carton", "set"].map(unit => <option key={unit} value={unit} />)}</datalist>
      <Button variant="secondary" disabled={locked || state.rows.length >= 100} onClick={() => flow.updateRows([...state.rows, emptyRow()])}>Add item</Button>
      <div className="review-total"><span>Grand total <small>NGN · Calculated from your edits</small></span><strong>{checked.totalAmount ? formatNgn(checked.totalAmount) : "—"}</strong></div>
      {checked.formError && <p className="feedback feedback--error" role="alert">{checked.formError}</p>}
      {!locked && <label className="review-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I have checked all items, quantities, selling units, and prices.</label>}
      {state.error && <div className="feedback feedback--error" role="alert">{state.error}{locked && <p>Your original save is retained. Retry uses the same sale ID to prevent duplicates. Editing is paused until its result is confirmed.</p>}</div>}
      <Button type="submit" loading={busy} disabled={!checked.valid || (!acknowledged && !locked) || busy}>{state.phase === "save-error" ? "Retry save safely" : "Confirm and Save"}<Icon name="check" /></Button>
      <p className="preview-note">Only Confirm and Save creates a sale. The server verifies final totals.</p>
    </form>
  </>;
}
