import { Explorer } from "@/components/Explorer";
import { DemoBanner } from "@/components/kit/DemoBanner";
import { ThemeToggle } from "@/components/kit/ThemeToggle";
import narrateFixtures from "@/fixtures/narrate-route.json";
import planFixtures from "@/fixtures/plan-route.json";
import type { FixtureStore } from "@/lib/demo";
import meta from "@/public/data/wasatch.json";

/** The one-line answer to "what is this?", shown under the name on every screen size. */
const PITCH =
  "Real elevation data of the Wasatch mountains in 3D. Pick two places and it finds a route that balances distance and climbing.";

/** True while any AI sample is hand-written. Driven by the fixtures' own flags, like the captions. */
const AI_SAMPLES_ARE_PLACEHOLDERS = [
  ...Object.values(planFixtures as FixtureStore),
  ...Object.values(narrateFixtures as FixtureStore),
].some((fixture) => fixture.placeholder);

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

function CautionIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden
      className="mt-px shrink-0 text-contour"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 1.8 15 14H1z" />
      <path d="M8 6.5v3.2M8 11.9v.1" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <DemoBanner aiRequired={false} placeholder={AI_SAMPLES_ARE_PLACEHOLDERS} />
      <header className="border-b border-border px-4 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Mark />
            <h1 className="text-lg font-semibold tracking-tight">Ridgeline</h1>
            <p className="hidden truncate text-sm text-muted xl:block">{PITCH}</p>
          </div>
          <ThemeToggle />
        </div>
        <p className="mt-0.5 text-xs leading-snug text-muted sm:text-[13px] xl:hidden">{PITCH}</p>
      </header>
      {/* Persistent on purpose: the slope shading uses avalanche-map colours. Calm, not alarming. */}
      <p
        role="note"
        className="flex items-start gap-2 border-b border-border bg-surface px-4 py-1.5 text-xs leading-snug text-muted"
      >
        <CautionIcon />
        <span>
          <strong className="font-medium text-fg">
            Not for backcountry navigation or avalanche decisions.
          </strong>{" "}
          <span className="hidden sm:inline">
            Routes ignore trails, cliffs, snow and closures. For avalanche conditions, read the{" "}
          </span>
          <span className="sm:hidden">Check the </span>
          <a
            href="https://utahavalanchecenter.org"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-fg underline underline-offset-2"
          >
            Utah Avalanche Center
          </a>{" "}
          forecast.
        </span>
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
