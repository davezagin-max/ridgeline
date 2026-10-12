/**
 * The facts a narration may use, and the check that it used nothing else.
 *
 * The router's numbers are formatted here, once, into the exact strings a
 * person will read ("7.4 mi", "1,850 ft", "2 h 05 min"). The model is given
 * those strings and told to quote them. `checkNarration` then pulls every
 * numeral out of what the model wrote and rejects the text if any of them is
 * not one of the numerals in the facts. A distance the router did not produce
 * cannot reach the screen. The text must also state the distance and the
 * total climb verbatim, so a narration cannot pass by saying nothing.
 */
import { z } from "zod";
import { findLandmark } from "../terrain/landmarks";
import { MODE_CLIMB_WEIGHT } from "../terrain/route";
import {
  formatDistance,
  formatDuration,
  formatGrade,
  formatHeight,
  type Units,
} from "../terrain/units";
import type { RoutePlan } from "./planner";

const line = z.string().min(1).max(120);

export const FactsSchema = z.object({
  from: line,
  to: line,
  shape: z.enum(["one way", "out and back"]),
  activity: z.enum(["hike", "ride"]),
  mode: z.enum(["climb-friendly", "shortest"]),
  distance: line,
  climb: line,
  descent: line,
  startElevation: line,
  endElevation: line,
  highPoint: line,
  lowPoint: line,
  steepestGrade: line,
  estimatedTime: line,
  /** One sentence per limit the person set, saying whether the route meets it. */
  limits: z.array(z.string().min(1).max(200)).max(4),
});

export type RouteFacts = z.infer<typeof FactsSchema>;

export const NarrationSchema = z.object({
  title: z.string(),
  narration: z.string(),
});

export type Narration = z.infer<typeof NarrationSchema> & {
  /** "model" when Claude wrote it, "template" when code assembled it from the facts. */
  source: "model" | "template";
};

export const NarrationDataSchema = NarrationSchema.extend({
  source: z.enum(["model", "template"]),
});

export const NARRATION_LIMITS = { title: 80, narration: 700 } as const;

/** Formats a plan's numbers into the strings shown to the person and given to the model. */
export function buildFacts(plan: RoutePlan, units: Units): RouteFacts {
  if (!plan.found || !plan.stats || !plan.destination) {
    throw new Error("Cannot describe a plan that found no route.");
  }
  const { stats, constraints } = plan;
  const from = findLandmark(constraints.start)?.name ?? constraints.start;
  const to = findLandmark(plan.destination)?.name ?? plan.destination;

  const limits = plan.checks.map((check) => {
    if (check.kind === "climb") {
      const limit = formatHeight(check.limitM, units);
      if (!check.ok) return `Climb limit of ${limit}: not met. No gentler line was found.`;
      // The planner had to raise the climb weight above the mode's own to get under the cap.
      return plan.climbWeight > MODE_CLIMB_WEIGHT[constraints.mode]
        ? `Climb limit of ${limit}: met, by taking a gentler line than the most direct one.`
        : `Climb limit of ${limit}: met.`;
    }
    if (check.kind === "duration") {
      return check.ok
        ? `Target time of ${formatDuration(check.targetMin)}: close.`
        : `Target time of ${formatDuration(check.targetMin)}: not close. This was the nearest option.`;
    }
    return `Grade limit of ${formatGrade(check.limitPct)}: met.`;
  });

  return {
    from,
    to,
    shape: plan.roundTrip ? "out and back" : "one way",
    activity: constraints.activity,
    mode: constraints.mode,
    distance: formatDistance(stats.distanceM, units),
    climb: formatHeight(stats.climbM, units),
    descent: formatHeight(stats.descentM, units),
    startElevation: formatHeight(stats.startElevationM, units),
    endElevation: formatHeight(stats.endElevationM, units),
    highPoint: formatHeight(stats.maxElevationM, units),
    lowPoint: formatHeight(stats.minElevationM, units),
    steepestGrade: formatGrade(stats.maxGradePct),
    estimatedTime: formatDuration(stats.minutes),
    limits,
  };
}

/** The facts as the plain "key: value" block the model reads. */
export function factsText(facts: RouteFacts): string {
  const rows = [
    `from: ${facts.from}`,
    `to: ${facts.to}`,
    `shape: ${facts.shape}`,
    `activity: ${facts.activity}`,
    `routing mode: ${facts.mode}`,
    `distance: ${facts.distance}`,
    `total climb: ${facts.climb}`,
    `total descent: ${facts.descent}`,
    `start elevation: ${facts.startElevation}`,
    `end elevation: ${facts.endElevation}`,
    `high point: ${facts.highPoint}`,
    `low point: ${facts.lowPoint}`,
    `steepest grade: ${facts.steepestGrade}`,
    `estimated time: ${facts.estimatedTime}`,
    ...facts.limits.map((limit) => `limit: ${limit}`),
  ];
  return rows.join("\n");
}

/** Every numeral in a string, with thousands separators removed: "1,850 ft" gives ["1850"]. */
export function numerals(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((token) => token.replaceAll(",", ""));
}

export interface NarrationCheck {
  ok: boolean;
  /** Human-readable problems, safe to send back to the model as a correction. */
  problems: string[];
}

/** Accepts a narration only if every numeral in it appears in the facts. */
export function checkNarration(
  value: { title: string; narration: string },
  facts: RouteFacts,
): NarrationCheck {
  const problems: string[] = [];
  const title = value.title.trim();
  const narration = value.narration.trim();
  if (!title) problems.push("The title is empty.");
  if (!narration) problems.push("The narration is empty.");
  if (title.length > NARRATION_LIMITS.title) {
    problems.push(`The title is longer than ${NARRATION_LIMITS.title} characters.`);
  }
  if (narration.length > NARRATION_LIMITS.narration) {
    problems.push(`The narration is longer than ${NARRATION_LIMITS.narration} characters.`);
  }
  const allowed = new Set(numerals(factsText(facts)));
  const invented = [...new Set(numerals(`${title} ${narration}`))].filter(
    (token) => !allowed.has(token),
  );
  if (invented.length > 0) {
    problems.push(`These figures are not in the facts: ${invented.slice(0, 8).join(", ")}.`);
  }
  // A description of a route that leaves out how far and how much climbing is not one.
  if (narration && !narration.includes(facts.distance)) {
    problems.push(`State the distance exactly as given (${facts.distance}).`);
  }
  if (narration && !narration.includes(facts.climb)) {
    problems.push(`State the total climb exactly as given (${facts.climb}).`);
  }
  return { ok: problems.length === 0, problems };
}

/** A plain description assembled by code, used when the model's text fails the check twice. */
export function templateNarration(facts: RouteFacts): Narration {
  const verb = facts.activity === "ride" ? "ride" : "hike";
  const shape =
    facts.shape === "out and back"
      ? `An out-and-back ${verb} from ${facts.from} to ${facts.to}`
      : `A one-way ${verb} from ${facts.from} to ${facts.to}`;
  const sentences = [
    `${shape}: ${facts.distance} with ${facts.climb} of climbing and ${facts.descent} of descent.`,
    `It tops out at ${facts.highPoint}, the steepest step is ${facts.steepestGrade}, and the pace model puts it at about ${facts.estimatedTime}.`,
    ...facts.limits,
  ];
  return {
    title: `${facts.from} to ${facts.to}`.slice(0, NARRATION_LIMITS.title),
    narration: sentences.join(" "),
    source: "template",
  };
}
