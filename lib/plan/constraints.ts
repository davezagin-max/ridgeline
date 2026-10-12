/**
 * Route constraints: the one thing the model is asked to produce.
 *
 * The model fills in a strict tool call. Its input is then checked here, in
 * code, before anything is routed: the wire schema cannot carry numeric ranges
 * (the API rejects `minimum` and `maximum` in strict schemas), and unit
 * conversion is arithmetic the model should not be trusted with. The tool
 * therefore takes the climb limit exactly as the person wrote it, plus its
 * unit, and the conversion to metres happens here.
 */
import { z } from "zod";
import { LANDMARKS, LANDMARK_IDS } from "../terrain/landmarks";
import type { RouteMode } from "../terrain/route";
import type { Activity } from "../terrain/stats";
import { M_PER_FT } from "../terrain/units";

export interface RouteConstraints {
  /** Landmark id. */
  start: string;
  /** Landmark id, or null for an out-and-back whose far end the planner picks. */
  end: string | null;
  maxClimbM: number | null;
  maxGradePct: number | null;
  targetDurationMin: number | null;
  mode: RouteMode;
  activity: Activity;
}

export const LIMITS = {
  climbM: { min: 15, max: 5000 },
  gradePct: { min: 5, max: 45 },
  durationMin: { min: 10, max: 1440 },
} as const;

export const TOOL_NAME = "set_route_constraints";

/** JSON Schema properties for the strict tool. Every property is required; none carries a range. */
export function toolProperties(): Record<string, unknown> {
  return {
    start: {
      type: "string",
      enum: [...LANDMARK_IDS],
      description: "Id of the landmark the route starts from.",
    },
    end_or_loop: {
      type: "string",
      enum: [...LANDMARK_IDS, "loop"],
      description:
        'Id of the landmark the route ends at, or "loop" when the person wants to finish where they started and names no destination.',
    },
    max_climb: {
      type: ["number", "null"],
      description:
        "Upper limit on total climbing, copied as the number the person wrote, without converting units. Null when they give none.",
    },
    climb_unit: {
      type: "string",
      enum: ["ft", "m"],
      description: 'Unit of max_climb as the person wrote it. Use "ft" when max_climb is null.',
    },
    max_grade_pct: {
      type: ["number", "null"],
      description: "Steepest grade allowed, in percent. Null when the person gives none.",
    },
    target_duration_min: {
      type: ["number", "null"],
      description: "How long the outing should take, in minutes. Null when the person gives none.",
    },
    mode: {
      type: "string",
      enum: ["climb-friendly", "shortest"],
      description:
        '"shortest" only when the person asks for the shortest or most direct line; otherwise "climb-friendly".',
    },
    activity: {
      type: "string",
      enum: ["hike", "ride"],
      description: '"ride" for cycling or mountain biking, otherwise "hike".',
    },
  };
}

const ToolInput = z.object({
  start: z.string(),
  end_or_loop: z.string(),
  max_climb: z.number().nullable(),
  climb_unit: z.enum(["ft", "m"]),
  max_grade_pct: z.number().nullable(),
  target_duration_min: z.number().nullable(),
  mode: z.enum(["climb-friendly", "shortest"]),
  activity: z.enum(["hike", "ride"]),
});

export type ToolInput = z.infer<typeof ToolInput>;

/** The shape an API response or a fixture carries. Ranges are enforced by `checkConstraints`. */
export const ConstraintsSchema = z.object({
  start: z.string(),
  end: z.string().nullable(),
  maxClimbM: z.number().nullable(),
  maxGradePct: z.number().nullable(),
  targetDurationMin: z.number().nullable(),
  mode: z.enum(["climb-friendly", "shortest"]),
  activity: z.enum(["hike", "ride"]),
});

export type Checked = { ok: true; constraints: RouteConstraints } | { ok: false; error: string };

function inRange(value: number, range: { min: number; max: number }): boolean {
  return Number.isFinite(value) && value >= range.min && value <= range.max;
}

/** Semantic checks on constraints, whatever their origin (model, fixture, or the browser). */
export function checkConstraints(value: unknown): Checked {
  const parsed = ConstraintsSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "Constraints have the wrong shape." };
  const constraints = parsed.data;
  if (!LANDMARK_IDS.includes(constraints.start)) {
    return { ok: false, error: `Unknown start "${constraints.start.slice(0, 40)}".` };
  }
  if (constraints.end !== null && !LANDMARK_IDS.includes(constraints.end)) {
    return { ok: false, error: `Unknown destination "${constraints.end.slice(0, 40)}".` };
  }
  if (constraints.end === constraints.start) {
    return { ok: false, error: "Start and destination are the same place." };
  }
  if (constraints.maxClimbM !== null && !inRange(constraints.maxClimbM, LIMITS.climbM)) {
    return { ok: false, error: "Climb limit is out of range." };
  }
  if (constraints.maxGradePct !== null && !inRange(constraints.maxGradePct, LIMITS.gradePct)) {
    return { ok: false, error: "Grade limit is out of range." };
  }
  if (
    constraints.targetDurationMin !== null &&
    !inRange(constraints.targetDurationMin, LIMITS.durationMin)
  ) {
    return { ok: false, error: "Target duration is out of range." };
  }
  return { ok: true, constraints };
}

/** Turns the model's tool input into checked constraints, converting feet to metres in code. */
export function constraintsFromToolInput(input: unknown): Checked {
  const parsed = ToolInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Tool input has the wrong shape." };
  const tool = parsed.data;
  const climb =
    tool.max_climb === null
      ? null
      : tool.climb_unit === "ft"
        ? tool.max_climb * M_PER_FT
        : tool.max_climb;
  // A grade limit slightly outside the supported range is pulled in rather than rejected.
  const grade =
    tool.max_grade_pct === null || !Number.isFinite(tool.max_grade_pct)
      ? tool.max_grade_pct
      : Math.min(Math.max(tool.max_grade_pct, LIMITS.gradePct.min), LIMITS.gradePct.max);
  return checkConstraints({
    start: tool.start,
    end: tool.end_or_loop === "loop" ? null : tool.end_or_loop,
    maxClimbM: climb === null ? null : Math.round(climb * 10) / 10,
    maxGradePct: grade,
    targetDurationMin: tool.target_duration_min,
    mode: tool.mode,
    activity: tool.activity,
  } satisfies RouteConstraints);
}

/** The landmark table given to the model: one "id | name | kind" line per place. */
export function landmarkReference(): string {
  return LANDMARKS.map((landmark) => `${landmark.id} | ${landmark.name} | ${landmark.kind}`).join(
    "\n",
  );
}
