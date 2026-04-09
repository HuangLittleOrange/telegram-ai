import type { AiJudgeDecision, AiQueryPlan } from './aiOrchestrator';

export type AiThinkingStep = {
  text: string;
  createdAt: number;
};

export type AiThinkingStage = 'retriever' | 'answer' | 'summary';

export type AiThinkingTraceStep = {
  stage: AiThinkingStage;
  title: string;
  detail?: string;
  createdAt: number;
};

export type AiThinkingTraceStepInput = {
  stage: AiThinkingStage;
  title: string;
  detail?: string;
  createdAt?: number;
};

export type AiThinkingLog = {
  startedAt: number;
  endedAt?: number;
  steps: AiThinkingTraceStep[];
};

export type AiThinkingSummary = {
  label: string;
  stepCount: number;
  durationMs: number;
};

export function formatAiThinkingDuration(durationMs: number) {
  const normalized = Math.max(0, Math.floor(durationMs));
  const totalSeconds = Math.max(1, Math.round(normalized / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (!minutes) {
    return `${seconds}s`;
  }

  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function createAiThinkingTraceStep(input: AiThinkingTraceStepInput): AiThinkingTraceStep {
  return {
    stage: input.stage,
    title: input.title.trim(),
    detail: input.detail?.trim() || undefined,
    createdAt: input.createdAt || Date.now(),
  };
}

function formatAiList(items: string[], fallback: string) {
  const normalized = items.map((item) => item.trim()).filter(Boolean);
  return normalized.length ? normalized.join('、') : fallback;
}

function formatAiEvidenceType(type: string) {
  const normalized = type.trim().toLowerCase();
  const labels: Record<string, string> = {
    original_quote: '原话',
    context: '上下文',
    counter_argument: '反驳点',
    supporting_fact: '事实证据',
  };

  return labels[normalized] || type.trim();
}

export function summarizeAiRetrievalPlan(
  plan: Pick<AiQueryPlan, 'goal' | 'retrievalGoals' | 'targetEvidenceTypes' | 'speakerHints' | 'timeHints'>,
) {
  const goals = formatAiList(plan.retrievalGoals, plan.goal);
  const evidenceTypes = plan.targetEvidenceTypes.length
    ? plan.targetEvidenceTypes.map(formatAiEvidenceType).join('、')
    : '通用聊天记录';
  const speakerHints = plan.speakerHints.length ? `发言人：${formatAiList(plan.speakerHints, '')}` : '';
  const timeHints = plan.timeHints.length ? `时间：${formatAiList(plan.timeHints, '')}` : '';

  return {
    title: `信息收集目标：${goals}`,
    detail: [
      `信息类型：${evidenceTypes}`,
      speakerHints,
      timeHints,
    ].filter(Boolean).join(' · '),
  };
}

export function summarizeAiJudgeDecision(
  decision: Pick<AiJudgeDecision, 'enough' | 'reason' | 'missing' | 'nextQueries' | 'historyInstruction'>,
) {
  const title = decision.enough
    ? '任务判断：已可完成'
    : '任务判断：还需继续收集';
  const detailParts = [
    decision.reason ? `判断：${decision.reason}` : undefined,
    decision.missing.length ? `缺口：${formatAiList(decision.missing, '暂无')}` : undefined,
    decision.nextQueries.length ? `下一轮：${formatAiList(decision.nextQueries, '暂无')}` : undefined,
    !decision.enough
      ? `动作：${decision.historyInstruction?.trim() || '继续向前补历史上下文'}`
      : undefined,
  ].filter(Boolean);

  return {
    title,
    detail: detailParts.length ? detailParts.join(' · ') : '暂无额外说明',
  };
}

export function buildAiThinkingSummary(log: AiThinkingLog): AiThinkingSummary {
  const durationMs = Math.max(0, (log.endedAt || log.startedAt) - log.startedAt);
  const stepCount = log.steps.length;

  return {
    label: `已处理 ${formatAiThinkingDuration(durationMs)}`,
    stepCount,
    durationMs,
  };
}
