export type AiEvidenceSource = 'recent' | 'cache' | 'history';

export type AiEvidenceItem = {
  chatId: string;
  threadId: number | string;
  messageId: number;
  sender: string;
  text: string;
  source: AiEvidenceSource;
  date?: number;
};

export type AiQueryPlan = {
  goal: string;
  nextAction?: string;
  nextActionReason?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolQueryHints?: unknown[];
  needRecentContext: boolean;
  needHistory: boolean;
  needReplyChain: boolean;
  retrievalGoals: string[];
  retrievalQueries: string[];
  speakerHints: string[];
  timeHints: string[];
  targetEvidenceTypes: string[];
  targetEvidenceCount: number;
  maxRounds: number;
  stopWhen: string;
  reasoningSummary?: string;
};

export type AiJudgeDecision = {
  enough: boolean;
  needMoreHistory: boolean;
  reason: string;
  missing: string[];
  nextQueries: string[];
  beforeMessageId?: number;
  historyInstruction?: string;
  nextAction?: string;
  nextActionReason?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolQueryHints?: unknown[];
  reasoningSummary?: string;
};

type RunAiPlannerRetrieverJudgeOptions = {
  userPrompt: string;
  initialEvidence: AiEvidenceItem[];
  requestPlan: (userPrompt: string) => Promise<string>;
  requestJudge: (args: {
    userPrompt: string;
    plan: AiQueryPlan;
    evidence: AiEvidenceItem[];
  }) => Promise<string>;
  fetchOlderEvidence: (args: {
    userPrompt: string;
    plan: AiQueryPlan;
    judge: AiJudgeDecision;
    evidence: AiEvidenceItem[];
    beforeMessageId?: number;
    round: number;
  }) => Promise<AiEvidenceItem[]>;
};

type AiRetrievalRound = {
  judge: AiJudgeDecision;
  fetchedCount: number;
  totalEvidenceCount: number;
};

export type AiPlannerRetrieverJudgeResult = {
  plan: AiQueryPlan;
  judge: AiJudgeDecision;
  evidence: AiEvidenceItem[];
  rounds: AiRetrievalRound[];
};

const DEFAULT_TARGET_EVIDENCE_COUNT = 8;
const DEFAULT_MAX_ROUNDS = 12;
const NO_PROGRESS_ROUNDS_LIMIT = 2;
const HARD_MAX_ROUNDS = 12;

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() || trimmed;

  try {
    return JSON.parse(candidate);
  } catch (err) {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      return undefined;
    }

    try {
      return JSON.parse(objectMatch[0]);
    } catch (innerErr) {
      return undefined;
    }
  }
}

function normalizeStringArray(values: unknown, fallback: string[] = []) {
  if (!Array.isArray(values)) {
    return fallback;
  }

  const filtered = values.filter((item: unknown) => typeof item === 'string' && item.trim()) as string[];
  return filtered.length ? filtered.map((item) => item.trim()) : fallback;
}

export function parseAiQueryPlan(text: string, userPrompt: string): AiQueryPlan {
  const parsed = extractJsonObject(text);
  const toolQueryHints = Array.isArray(parsed?.toolQueryHints)
    ? parsed.toolQueryHints.filter((item: unknown) => Boolean(item))
    : [];

  return {
    goal: typeof parsed?.goal === 'string' && parsed.goal.trim() ? parsed.goal.trim() : userPrompt,
    nextAction: typeof parsed?.nextAction === 'string' && parsed.nextAction.trim()
      ? parsed.nextAction.trim()
      : undefined,
    nextActionReason: typeof parsed?.nextActionReason === 'string' && parsed.nextActionReason.trim()
      ? parsed.nextActionReason.trim()
      : undefined,
    toolName: typeof parsed?.toolName === 'string' && parsed.toolName.trim()
      ? parsed.toolName.trim()
      : undefined,
    toolArgs: parsed?.toolArgs,
    toolQueryHints,
    needRecentContext: parsed?.needRecentContext !== false,
    needHistory: parsed?.needHistory !== false,
    needReplyChain: Boolean(parsed?.needReplyChain),
    retrievalGoals: normalizeStringArray(parsed?.retrievalGoals, [userPrompt]),
    retrievalQueries: normalizeStringArray(parsed?.retrievalQueries, [userPrompt]),
    speakerHints: normalizeStringArray(parsed?.speakerHints),
    timeHints: normalizeStringArray(parsed?.timeHints),
    targetEvidenceTypes: normalizeStringArray(parsed?.targetEvidenceTypes),
    targetEvidenceCount: Number.isFinite(parsed?.targetEvidenceCount)
      ? Math.max(3, Math.min(24, Math.floor(parsed.targetEvidenceCount)))
      : DEFAULT_TARGET_EVIDENCE_COUNT,
    maxRounds: Number.isFinite(parsed?.maxRounds)
      ? Math.max(1, Math.min(5, Math.floor(parsed.maxRounds)))
      : DEFAULT_MAX_ROUNDS,
    stopWhen: typeof parsed?.stopWhen === 'string' && parsed.stopWhen.trim()
      ? parsed.stopWhen.trim()
      : '找到足够回答用户问题的证据',
    reasoningSummary: typeof parsed?.reasoningSummary === 'string' && parsed.reasoningSummary.trim()
      ? parsed.reasoningSummary.trim()
      : undefined,
  };
}

export function parseAiJudgeDecision(text: string): AiJudgeDecision {
  const parsed = extractJsonObject(text);
  const toolQueryHints = Array.isArray(parsed?.toolQueryHints)
    ? parsed.toolQueryHints.filter((item: unknown) => Boolean(item))
    : [];
  const needMoreHistory = typeof parsed?.needMoreHistory === 'boolean'
    ? parsed.needMoreHistory
    : parsed?.fetchOlder !== false;

  return {
    enough: Boolean(parsed?.enough),
    needMoreHistory,
    reason: typeof parsed?.reason === 'string' ? parsed.reason.trim() : '',
    missing: Array.isArray(parsed?.missing)
      ? parsed.missing.filter((item: unknown) => typeof item === 'string' && item.trim())
      : [],
    nextQueries: Array.isArray(parsed?.nextQueries)
      ? parsed.nextQueries.filter((item: unknown) => typeof item === 'string' && item.trim())
      : [],
    beforeMessageId: Number.isFinite(parsed?.beforeMessageId) && parsed.beforeMessageId > 0
      ? Math.floor(parsed.beforeMessageId)
      : undefined,
    historyInstruction: typeof parsed?.historyInstruction === 'string' && parsed.historyInstruction.trim()
      ? parsed.historyInstruction.trim()
      : undefined,
    nextAction: typeof parsed?.nextAction === 'string' && parsed.nextAction.trim()
      ? parsed.nextAction.trim()
      : undefined,
    nextActionReason: typeof parsed?.nextActionReason === 'string' && parsed.nextActionReason.trim()
      ? parsed.nextActionReason.trim()
      : undefined,
    toolName: typeof parsed?.toolName === 'string' && parsed.toolName.trim()
      ? parsed.toolName.trim()
      : undefined,
    toolArgs: parsed?.toolArgs,
    toolQueryHints,
    reasoningSummary: typeof parsed?.reasoningSummary === 'string' && parsed.reasoningSummary.trim()
      ? parsed.reasoningSummary.trim()
      : undefined,
  };
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(value: string) {
  return normalizeText(value).split(/[\s,，。；;:：!?！？()[\]{}"'`]+/).filter(Boolean);
}

function scoreSnippet(haystack: string, snippet: string, fullMatchWeight: number, tokenWeight: number) {
  let score = 0;
  const normalizedSnippet = normalizeText(snippet);
  if (normalizedSnippet && haystack.includes(normalizedSnippet)) {
    score += fullMatchWeight;
  }

  tokenize(snippet).forEach((token) => {
    if (haystack.includes(token)) {
      score += tokenWeight;
    }
  });

  return score;
}

function getEvidenceKey(item: AiEvidenceItem) {
  return `${item.chatId}:${item.threadId}:${item.messageId}`;
}

export function dedupeAiEvidence(items: AiEvidenceItem[]) {
  const byKey = new Map<string, AiEvidenceItem>();

  items.forEach((item) => {
    byKey.set(getEvidenceKey(item), item);
  });

  return Array.from(byKey.values()).sort((a, b) => a.messageId - b.messageId);
}

function scoreAiEvidence(item: AiEvidenceItem, plan: AiQueryPlan) {
  const haystack = normalizeText(`${item.sender} ${item.text}`);
  let score = 0;

  plan.retrievalQueries.forEach((query) => {
    score += scoreSnippet(haystack, query, 12, 3);
  });

  plan.retrievalGoals.forEach((goal) => {
    score += scoreSnippet(haystack, goal, 8, 2);
  });

  plan.speakerHints.forEach((hint) => {
    if (normalizeText(item.sender).includes(normalizeText(hint))) {
      score += 6;
    }
  });

  plan.targetEvidenceTypes.forEach((type) => {
    const normalizedType = normalizeText(type);
    const typeHints: Record<string, string[]> = {
      original_quote: ['"', '“', '”', '说', '表示', '提到'],
      context: ['背景', '上下文', '前因', '后果', '因为', '所以', '讨论'],
      counter_argument: ['反驳', '反对', '不是', '并不', '但是', '不过', '然而', '质疑'],
      supporting_fact: ['数据', '证据', '事实', '数字', '统计', 'http', 'https'],
    };

    const hints = typeHints[normalizedType] || tokenize(type);
    hints.forEach((hint) => {
      if (haystack.includes(normalizeText(hint))) {
        score += 2;
      }
    });
  });

  if (item.source === 'recent') {
    score += 1;
  }

  return score;
}

export function rankAiEvidenceByPlan(items: AiEvidenceItem[], plan: AiQueryPlan) {
  return [...items].sort((left, right) => {
    const scoreDiff = scoreAiEvidence(right, plan) - scoreAiEvidence(left, plan);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return left.messageId - right.messageId;
  });
}

function getDefaultBeforeMessageId(items: AiEvidenceItem[]) {
  return items.reduce<number | undefined>((oldest, item) => {
    if (!oldest) return item.messageId;
    return item.messageId < oldest ? item.messageId : oldest;
  }, undefined);
}

export async function runAiPlannerRetrieverJudge(
  options: RunAiPlannerRetrieverJudgeOptions,
): Promise<AiPlannerRetrieverJudgeResult> {
  const {
    userPrompt,
    initialEvidence,
    requestPlan,
    requestJudge,
    fetchOlderEvidence,
  } = options;

  const plan = parseAiQueryPlan(await requestPlan(userPrompt), userPrompt);
  let evidence = rankAiEvidenceByPlan(dedupeAiEvidence(initialEvidence), plan);
  let judge = parseAiJudgeDecision(await requestJudge({
    userPrompt,
    plan,
    evidence,
  }));
  const rounds: AiRetrievalRound[] = [];
  let noProgressRounds = 0;

  for (let round = 0; round < HARD_MAX_ROUNDS; round += 1) {
    if (judge.enough || !judge.needMoreHistory || !plan.needHistory) {
      rounds.push({
        judge,
        fetchedCount: 0,
        totalEvidenceCount: evidence.length,
      });
      break;
    }

    const olderEvidence = await fetchOlderEvidence({
      userPrompt,
      plan,
      judge,
      evidence,
      beforeMessageId: judge.beforeMessageId || getDefaultBeforeMessageId(evidence),
      round,
    });

    if (!olderEvidence.length) {
      rounds.push({
        judge,
        fetchedCount: 0,
        totalEvidenceCount: evidence.length,
      });
      break;
    }

    const evidenceCountBeforeFetch = evidence.length;
    evidence = rankAiEvidenceByPlan(dedupeAiEvidence([...olderEvidence, ...evidence]), plan);
    const evidenceCountAfterFetch = evidence.length;
    const gainedEvidence = evidenceCountAfterFetch - evidenceCountBeforeFetch;
    if (gainedEvidence > 0) {
      noProgressRounds = 0;
    } else {
      noProgressRounds += 1;
    }

    rounds.push({
      judge,
      fetchedCount: olderEvidence.length,
      totalEvidenceCount: evidence.length,
    });

    judge = parseAiJudgeDecision(await requestJudge({
      userPrompt,
      plan,
      evidence,
    }));

    if (noProgressRounds >= NO_PROGRESS_ROUNDS_LIMIT) {
      rounds.push({
        judge,
        fetchedCount: 0,
        totalEvidenceCount: evidence.length,
      });
      break;
    }
  }

  return {
    plan,
    judge,
    evidence: dedupeAiEvidence(evidence),
    rounds,
  };
}
