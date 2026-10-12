/**
 * The two Claude calls, server side. Each takes a client so tests can pass a
 * fake one. Both make at most two requests and both validate what comes back
 * before returning it.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { LiveResult } from "../api";
import { PipelineError, callClaude, strictTool, untrusted, type CallResult, type Msg } from "../claude";
import { MODELS, ZERO_USAGE, addUsage, type Usage } from "../config";
import {
  TOOL_NAME,
  constraintsFromToolInput,
  toolProperties,
  type RouteConstraints,
} from "./constraints";
import {
  NarrationSchema,
  checkNarration,
  factsText,
  templateNarration,
  type Narration,
  type RouteFacts,
} from "./facts";
import { NARRATE_SYSTEM, PLAN_NUDGE, PLAN_SYSTEM, TOOL_DESCRIPTION } from "./prompts";

/** Running total of what a multi-call step has cost. */
class Bill {
  usage: Usage = ZERO_USAGE;
  costUsd = 0;
  model: string = MODELS.opus;

  add(result: CallResult<unknown>): void {
    this.usage = addUsage(this.usage, result.usage);
    this.costUsd += result.costUsd;
    this.model = result.model;
  }

  get meta() {
    return { model: this.model, usage: this.usage, costUsd: this.costUsd };
  }
}

export const NO_ROUTE_MESSAGE =
  "Claude could not turn that into a route. Name a start from the map, such as Alta or Park City Old Town, and say what you want to do.";

/**
 * Request text to checked constraints.
 *
 * Tool use cannot be forced, so the call is checked: if the first reply has no
 * tool call, or a call whose values fail validation, the model gets one
 * correction and one more try. After that the visitor is told plainly.
 */
export async function interpretRequest(
  client: Anthropic,
  request: string,
  signal?: AbortSignal,
): Promise<LiveResult<RouteConstraints>> {
  const bill = new Bill();
  const tools = [strictTool(TOOL_NAME, TOOL_DESCRIPTION, toolProperties())];
  let messages: Msg[] = [{ role: "user", content: untrusted("request", request) }];

  for (let attempt = 1; attempt <= 2; attempt++) {
    // A visitor who cancelled or left must not be billed for the second try.
    signal?.throwIfAborted();
    const result = await callClaude({
      client,
      model: MODELS.opus,
      effort: "low",
      system: PLAN_SYSTEM,
      cacheSystem: true,
      messages,
      tools,
      maxTokens: 4000,
      signal,
    });
    bill.add(result);
    if (result.refusal) return { refusal: result.refusal, ...bill.meta };

    const call = result.toolCalls.find((entry) => entry.name === TOOL_NAME);
    if (!call) {
      // No call: ask once more in a new user turn. The history is only ever appended to.
      messages = [...result.messages, { role: "user", content: PLAN_NUDGE }];
      continue;
    }
    const checked = constraintsFromToolInput(call.input);
    if (checked.ok) return { data: checked.constraints, ...bill.meta };
    // A call with unusable values: answer it with an error result so the model can correct it.
    messages = [
      ...result.messages,
      {
        role: "user",
        content: result.toolCalls.map((entry) => ({
          type: "tool_result" as const,
          tool_use_id: entry.id,
          content: `Rejected: ${checked.error} Call ${TOOL_NAME} again with corrected values.`,
          is_error: true,
        })),
      },
    ];
  }
  throw new PipelineError(NO_ROUTE_MESSAGE, 422);
}

/**
 * Router facts to a short narration.
 *
 * The model's text is accepted only if every numeral in it appears in the
 * facts. One rewrite is allowed; after that the narration is assembled by code
 * from the same facts, and marked as such.
 */
export async function narrateRoute(
  client: Anthropic,
  request: string,
  facts: RouteFacts,
  signal?: AbortSignal,
): Promise<LiveResult<Narration>> {
  const bill = new Bill();
  let messages: Msg[] = [
    {
      role: "user",
      content: `${untrusted("request", request)}\n\n${untrusted("facts", factsText(facts))}`,
    },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    signal?.throwIfAborted();
    const result = await callClaude({
      client,
      model: MODELS.opus,
      effort: "low",
      system: NARRATE_SYSTEM,
      messages,
      schema: NarrationSchema,
      maxTokens: 4000,
      signal,
    });
    bill.add(result);
    if (result.refusal) return { refusal: result.refusal, ...bill.meta };

    const problems = result.parsed
      ? checkNarration(result.parsed, facts).problems
      : ["The reply was not in the requested format."];
    if (result.parsed && problems.length === 0) {
      return {
        data: {
          title: result.parsed.title.trim(),
          narration: result.parsed.narration.trim(),
          source: "model",
        },
        ...bill.meta,
      };
    }
    messages = [
      ...result.messages,
      {
        role: "user",
        content: `Rewrite it. ${problems.join(" ")} Use only figures from the facts, copied exactly.`,
      },
    ];
  }
  return { data: templateNarration(facts), ...bill.meta };
}
