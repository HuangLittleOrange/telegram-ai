import {
  type AiAgentLoopResult,
  runAiAgentLoop,
  type RunAiAgentLoopArgs,
} from './aiAgentRuntime';

export type RunAiQueryLoopArgs = RunAiAgentLoopArgs;
export type AiQueryLoopResult = AiAgentLoopResult;

export async function runAiQueryLoop(args: RunAiQueryLoopArgs): Promise<AiQueryLoopResult> {
  return runAiAgentLoop(args);
}
