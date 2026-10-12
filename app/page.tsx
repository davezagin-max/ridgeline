import { Explorer } from "@/components/Explorer";
import { DemoBanner } from "@/components/kit/DemoBanner";
import { ThemeToggle } from "@/components/kit/ThemeToggle";
import meta from "@/public/data/wasatch.json";

function Mark() {
  return (
    <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden className="shrink-0">
      <path
        d="M1 17 8 6l4 5 4-8 9 14"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M4 19h18" stroke="var(--contour)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <DemoBanner aiRequired={false} />
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Mark />
          <h1 className="text-base font-semibold tracking-tight">Ridgeline</h1>
          <p className="hidden truncate text-sm text-muted sm:block">
            Wasatch terrain explorer: Cottonwood Canyons to Park City
          </p>
        </div>
        <ThemeToggle />
      </header>
      {/* Persistent on purpose: the slope shading uses avalanche-map colours. */}
      <p
        role="note"
        className="border-b border-border bg-surface px-4 py-1.5 text-xs leading-snug text-fg"
      >
        <strong className="font-semibold text-danger">
          Not for backcountry navigation or avalanche decisions.
        </strong>{" "}
        Routes ignore trails, cliffs, snow and closures. For avalanche conditions, read the{" "}
        <a
          href="https://utahavalanchecenter.org"
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          Utah Avalanche Center
        </a>{" "}
        forecast.
      </p>
      <main id="main" className="flex flex-1 flex-col lg:min-h-0">
        <Explorer />
      </main>
      <footer className="border-t border-border px-4 py-2 text-center text-[11px] leading-relaxed text-muted">
        {meta.source.attribution} Built with Claude Code and Claude Opus 5.5.
      </footer>
    </div>
  );
}
