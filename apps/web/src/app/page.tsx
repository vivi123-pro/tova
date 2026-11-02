import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { buttonClassName } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/presentation";
import { RecentSales, SalesSummary } from "@/features/sales/components/sales-overview";
import { ResumeSale } from "@/features/sales/components/sales-session";

export default function Home() {
  return <>
    <ResumeSale />
    <PageHeader eyebrow="YOUR EVERYDAY, A LITTLE LIGHTER" title="Hello, let's make room for more."><p>Less time writing. More time doing what you love.</p></PageHeader>
    <section className="record-hero" aria-labelledby="hero-title">
      <div className="hero-copy"><p className="eyebrow">A sale starts with your voice</p><h2 id="hero-title">Your sales,<br /><em>in your words.</em></h2><p>Say what you sold, how many, and the price.<br className="desktop-break" /> Start with a simple recording.</p><Link href="/record" className={buttonClassName("secondary", "hero-action")}><Icon name="mic" />Record a sale<Icon name="arrow" /></Link></div>
      <div className="hero-art" aria-hidden="true"><div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /><div className="hero-mic"><Icon name="mic" width="54" height="54" /></div><div className="wave-bars">{[18, 32, 50, 28, 64, 40, 22, 48, 30, 16].map((height, i) => <span key={i} style={{ height }} />)}</div><span className="hero-art-caption">A few words. A little less work.</span></div>
    </section>
    <SalesSummary />
    <RecentSales />
  </>;
}
