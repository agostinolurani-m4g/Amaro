// Tipi dell'agente coach (implementazione in agent.mjs).

type Block = { type: string; [key: string]: unknown };

export interface CoachLlm {
  call(req: {
    system: string;
    messages: { role: "user" | "assistant"; content: string | Block[] }[];
    tools?: { name: string; description: string; input_schema: unknown }[];
    mode?: "chat" | "json";
    onText?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<{ content: Block[]; stop_reason: string | null }>;
}

export interface CoachAgentEvent {
  type: "delta" | "tool_start" | "tool_end";
  text?: string;
  name?: string;
  label?: string;
}

export interface CoachAgentPlanSession {
  date: string;
  name: string;
  durationMin: number;
  [key: string]: unknown;
}

export interface CoachAgentResponse {
  reply: string;
  artifacts?: any[];
  planUpdate?: any[];
  planMode?: "replace" | "merge";
  phases?: any[];
  workouts?: any[];
  persistentConstraint?: string;
  lifeBlocks?: any[];
  toolsUsed: string[];
}

export const COACH_SYSTEM: string;

export function chatWithCoach(input: {
  llm: CoachLlm;
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
  context: unknown;
  directIntent?: string;
  memberId?: number;
  emit?: (event: CoachAgentEvent) => void;
  signal?: AbortSignal;
}): Promise<CoachAgentResponse>;

export function coachSessionComment(input: {
  llm: CoachLlm;
  context: unknown;
  session: unknown;
  planned?: unknown;
  evaluation?: unknown;
  athleteProfile?: unknown;
}): Promise<{ comment: string }>;

export function coachWeeklyReview(input: {
  llm: CoachLlm;
  context: unknown;
  constraints?: string[];
}): Promise<{ athleteProfile: any; weekReview: string; plan: any[] }>;

export function coachAdjustPlan(input: {
  llm: CoachLlm;
  message: string;
  context: unknown;
  constraints?: string[];
}): Promise<{
  reply: string;
  plan: any[];
  planMode: "replace" | "merge";
  workouts: any[];
  persistentConstraint?: string;
  lifeBlocks?: any[];
}>;

export function coachBatchComments(input: {
  llm: CoachLlm;
  context: unknown;
  sessions: unknown[];
  athleteProfile?: unknown;
}): Promise<{ comments: { id: string; comment: string }[] }>;
