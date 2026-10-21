import type { ReactNode, SVGProps } from "react";

type IconName = "mic" | "home" | "history" | "arrow" | "bag" | "stop" | "check" | "refresh" | "close";
const paths: Record<IconName, ReactNode> = {
  mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>,
  home: <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />,
  history: <path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7M12 7v5l3 2" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  bag: <><rect x="4" y="7" width="16" height="14" rx="2" /><path d="M8 8V6a4 4 0 0 1 8 0v2m-8 4h.01M16 12h.01" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  check: <path d="m5 12 4 4L19 6" />,
  refresh: <path d="M20 7v5h-5M4 17v-5h5M6.5 6a8 8 0 0 1 13 4M4.5 14a8 8 0 0 0 13 4" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
};
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
