import type { FC } from '@teact';
import {
  memo,
  useEffect,
  useState,
} from '@teact';
import type React from '../../lib/teact/teact';
import type { TeactNode } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiChat } from '../../api/types';
import type { ChatSyncState } from '../../global/types';
import type {
  AiAssistantStreamStatus,
  ToolOutput,
} from '../../global/types/tabState';
import type { TimeRange } from '../../global/types/tabState';
import type { ThreadId } from '../../types';
import { MAIN_THREAD_ID } from '../../api/types';
import { SettingsScreens } from '../../types';

import { isChatChannel, isChatGroup } from '../../global/helpers';
import { sanitizeAssistantText } from '../../global/helpers/ai';
import {
  type AiThinkingTraceStep,
  buildAiThinkingSummary,
  formatAiThinkingDuration,
} from '../../global/helpers/aiThinking';
import {
  selectChat,
  selectTabState,
} from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { copyTextToClipboard } from '../../util/clipboard';
import { formatAiToolOutputSummary } from './helpers/aiToolOutput';
import {
  type MarkdownBlock,
  type MarkdownInlineNode,
  parseMarkdownBlocks,
} from './helpers/markdown';

import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import SafeLink from '../common/SafeLink';
import Button from '../ui/Button';
import InputText from '../ui/InputText';

import './AiAssistant.scss';

type OwnProps = {
  chatId: string;
  threadId?: ThreadId;
  isActive?: boolean;
};

type StateProps = {
  chat?: ApiChat;
  syncState: ChatSyncState;
  turns: {
    role: 'user' | 'assistant';
    text: string;
    createdAt: number;
    thinkingLog?: {
      startedAt: number;
      endedAt?: number;
      steps: AiThinkingTraceStep[];
    };
  }[];
  isLoading?: boolean;
  streamStatus?: AiAssistantStreamStatus;
  activeStage?: AiThinkingTraceStep['stage'];
  draftText?: string;
  finalText?: string;
  toolOutputs: ToolOutput[];
  thinkingStage?: string;
  thinkingStartedAt?: number;
  thinkingEndedAt?: number;
  thinkingTrace: {
    stage: AiThinkingTraceStep['stage'];
    title: string;
    detail?: string;
    createdAt: number;
  }[];
  error?: string;
  hasApiKey: boolean;
};

type RangeOption = 'all' | 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'custom';

const PRESET_LABELS: Record<Exclude<RangeOption, 'all' | 'custom'>, string> = {
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  lastWeek: '上周',
  thisMonth: '本月',
};

const DEFAULT_SYNC_STATE: ChatSyncState = {
  selectedMethod: 'dataExport',
  status: 'idle',
  syncedMessages: 0,
  unsyncedMessages: 0,
};

function toDateTimeLocalValue(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function getRangeOption(range?: TimeRange): RangeOption {
  if (!range) {
    return 'all';
  }

  if (range.mode === 'custom') {
    return 'custom';
  }

  return range.value;
}

function getDefaultCustomRange() {
  const endAt = Date.now();
  const startAt = endAt - 7 * 24 * 60 * 60 * 1000;
  return { startAt, endAt };
}

function renderAssistantContent(text: string) {
  return parseMarkdownBlocks(text).map((block, blockIndex) => renderMarkdownBlock(block, blockIndex));
}

function renderMarkdownInlineNodes(nodes: MarkdownInlineNode[], keyPrefix: string): TeactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (node.type) {
      case 'text':
        return <span key={key}>{node.value}</span>;

      case 'strong':
        return <strong key={key}>{renderMarkdownInlineNodes(node.children, key)}</strong>;

      case 'em':
        return <em key={key}>{renderMarkdownInlineNodes(node.children, key)}</em>;

      case 'code':
        return <code key={key} className="AiAssistant__markdown-inline-code">{node.value}</code>;

      case 'link':
        return (
          <SafeLink key={key} url={node.href} text={node.href} className="AiAssistant__markdown-link">
            {renderMarkdownInlineNodes(node.children, key)}
          </SafeLink>
        );
    }
  });
}

function renderMarkdownBlock(block: MarkdownBlock, blockIndex: number) {
  switch (block.type) {
    case 'heading': {
      const className = block.level === 1
        ? 'AiAssistant__markdown-heading is-h1'
        : block.level === 2
          ? 'AiAssistant__markdown-heading is-h2'
          : 'AiAssistant__markdown-heading is-h3';

      return (
        <div key={blockIndex} className={className}>
          {renderMarkdownInlineNodes(block.children, `heading-${blockIndex}`)}
        </div>
      );
    }

    case 'paragraph':
      return (
        <p key={blockIndex} className="AiAssistant__markdown-paragraph">
          {renderMarkdownInlineNodes(block.children, `paragraph-${blockIndex}`)}
        </p>
      );

    case 'blockquote':
      return (
        <blockquote key={blockIndex} className="AiAssistant__markdown-blockquote">
          {renderMarkdownInlineNodes(block.children, `blockquote-${blockIndex}`)}
        </blockquote>
      );

    case 'list':
      return block.ordered ? (
        <ol key={blockIndex} className="AiAssistant__markdown-list is-ordered">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderMarkdownInlineNodes(item, `ol-${blockIndex}-${itemIndex}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={blockIndex} className="AiAssistant__markdown-list">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderMarkdownInlineNodes(item, `ul-${blockIndex}-${itemIndex}`)}</li>
          ))}
        </ul>
      );

    case 'code':
      return (
        <pre key={blockIndex} className="AiAssistant__markdown-code-block">
          {block.language && (
            <div className="AiAssistant__markdown-code-language">{block.language}</div>
          )}
          <code>{block.value}</code>
        </pre>
      );

    case 'hr':
      return <hr key={blockIndex} className="AiAssistant__markdown-divider" />;
  }
}

type TypingTextProps = {
  text: string;
  isLive?: boolean;
  className?: string;
  delayMs?: number;
};

const TypingText: FC<TypingTextProps> = memo(({ text, isLive, className, delayMs = 0 }) => {
  const [visibleLength, setVisibleLength] = useState(isLive ? 0 : text.length);

  useEffect(() => {
    if (!isLive) {
      setVisibleLength(text.length);
      return undefined;
    }

    setVisibleLength(0);
    if (!text) {
      return undefined;
    }

    const totalTicks = Math.max(8, Math.min(28, text.length));
    const charsPerTick = Math.max(1, Math.ceil(text.length / totalTicks));
    let currentLength = 0;

    let typingTimer: number | undefined;
    const startTimer = window.setTimeout(() => {
      typingTimer = window.setInterval(() => {
        currentLength = Math.min(text.length, currentLength + charsPerTick);
        setVisibleLength(currentLength);

        if (currentLength >= text.length && typingTimer) {
          window.clearInterval(typingTimer);
        }
      }, 22);
    }, delayMs);

    return () => {
      window.clearTimeout(startTimer);
      if (typingTimer) {
        window.clearInterval(typingTimer);
      }
    };
  }, [delayMs, isLive, text]);

  const visibleText = text.slice(0, visibleLength);

  return (
    <span className={buildClassName('AiAssistant__typingText', className)}>
      {visibleText}
      {Boolean(isLive && visibleLength < text.length) && (
        <span className="AiAssistant__typingCaret" aria-hidden="true" />
      )}
    </span>
  );
});

const THINKING_STAGE_LABELS: Record<AiThinkingTraceStep['stage'], string> = {
  retriever: '收集',
  answer: '结果',
  summary: '总结',
};

const STREAM_STATUS_LABELS: Record<AiAssistantStreamStatus, string> = {
  idle: '空闲',
  streaming: '处理中',
  cancelling: '正在中止',
  cancelled: '已中止',
  error: '失败',
  done: '完成',
};

function formatToolOutputSummary(toolOutput: ToolOutput) {
  return formatAiToolOutputSummary(toolOutput);
}

const AiAssistant: FC<OwnProps & StateProps> = ({
  chatId,
  threadId,
  chat,
  syncState,
  turns,
  isLoading,
  streamStatus,
  activeStage,
  draftText,
  finalText,
  toolOutputs,
  thinkingStage,
  thinkingStartedAt,
  thinkingEndedAt,
  thinkingTrace = [],
  error,
  hasApiKey,
  isActive,
}) => {
  const {
    openChatWithDraft,
    openSettingsScreen,
    clearAiTurns,
    requestAiExtractTodos,
    cancelAiPrompt,
    requestAiPrompt,
    requestAiReplySuggestions,
    requestAiSummaryToday,
    loadChatSyncStats,
    pauseChatSync,
    resetChatSync,
    setChatSyncMethod,
    setChatSyncTimeRange,
    startChatSync,
    showNotification,
  } = getActions();

  const [prompt, setPrompt] = useState('');
  const [isSyncSettingsOpen, setIsSyncSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [expandedThinkingEntries, setExpandedThinkingEntries] = useState<Record<string, boolean>>({});
  const [customStartAt, setCustomStartAt] = useState(() => (
    syncState.selectedTimeRange?.mode === 'custom'
      ? syncState.selectedTimeRange.startAt
      : getDefaultCustomRange().startAt
  ));
  const [customEndAt, setCustomEndAt] = useState(() => (
    syncState.selectedTimeRange?.mode === 'custom'
      ? syncState.selectedTimeRange.endAt
      : getDefaultCustomRange().endAt
  ));
  const isSupportedChat = Boolean(chat && (isChatGroup(chat) || isChatChannel(chat)));
  const resolvedThreadId = threadId || MAIN_THREAD_ID;
  const selectedRangeOption = getRangeOption(syncState.selectedTimeRange);
  const isStreaming = streamStatus === 'streaming' || streamStatus === 'cancelling';
  const isCancelling = streamStatus === 'cancelling';
  const liveDraftText = streamStatus === 'done'
    ? ''
    : sanitizeAssistantText(finalText || draftText) || finalText || draftText || '';
  const hasLiveDraft = Boolean(liveDraftText.trim());

  useEffect(() => {
    if (!isSupportedChat) {
      return;
    }

    loadChatSyncStats({ chatId, threadId: resolvedThreadId });
  }, [chatId, isSupportedChat, loadChatSyncStats, resolvedThreadId]);

  useEffect(() => {
    if (syncState.selectedTimeRange?.mode !== 'custom') {
      return;
    }

    setCustomStartAt(syncState.selectedTimeRange.startAt);
    setCustomEndAt(syncState.selectedTimeRange.endAt);
  }, [syncState.selectedTimeRange]);

  useEffect(() => {
    if (!isLoading && !isStreaming) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isLoading, isStreaming]);

  const syncProgress = !syncState.totalMessages
    ? 0
    : Math.max(0, Math.min(100, Math.round((syncState.syncedMessages / syncState.totalMessages) * 100)));
  const syncStatusText = syncState.status === 'syncing'
    ? '同步中'
    : syncState.status === 'paused'
      ? '已暂停'
      : syncState.status === 'completed'
        ? '已完成'
        : syncState.status === 'error'
          ? '同步失败'
          : '待同步';
  const oldestSyncedDateText = syncState.oldestSyncedDate
    ? new Date(syncState.oldestSyncedDate).toLocaleString()
    : '暂无';

  const handleRangeSelect = (option: RangeOption) => {
    if (option === 'all') {
      setChatSyncTimeRange({ chatId, timeRange: undefined });
      return;
    }

    if (option === 'custom') {
      const customRange = syncState.selectedTimeRange?.mode === 'custom'
        ? syncState.selectedTimeRange
        : {
          mode: 'custom' as const,
          ...getDefaultCustomRange(),
        };
      setCustomStartAt(customRange.startAt);
      setCustomEndAt(customRange.endAt);
      setChatSyncTimeRange({ chatId, timeRange: customRange });
      return;
    }

    setChatSyncTimeRange({
      chatId,
      timeRange: {
        mode: 'preset',
        value: option,
      },
    });
  };

  const handleApplyCustomRange = useLastCallback(() => {
    if (!customStartAt || !customEndAt || customStartAt >= customEndAt) {
      return;
    }

    setChatSyncTimeRange({
      chatId,
      timeRange: {
        mode: 'custom',
        startAt: customStartAt,
        endAt: customEndAt,
      },
    });
  });

  const handleSendPrompt = useLastCallback(() => {
    if (isStreaming) {
      cancelAiPrompt();
      return;
    }

    const trimmed = prompt.trim();
    if (!trimmed) return;

    requestAiPrompt({ prompt: trimmed });
    setPrompt('');
  });

  const handlePromptKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isStreaming) {
        cancelAiPrompt();
        return;
      }
      handleSendPrompt();
    }
  });

  const handleInsert = useLastCallback((text: string) => {
    openChatWithDraft({
      chatId,
      threadId,
      text: { text },
    });
    showNotification({ message: '已插入输入框' });
  });

  const handleCopy = useLastCallback((text: string) => {
    copyTextToClipboard(text);
    showNotification({ message: '已复制到剪贴板' });
  });

  const handleClearHistory = useLastCallback(() => {
    clearAiTurns();
    setPrompt('');
    showNotification({ message: '已清空历史记录' });
  });

  const handleRetry = useLastCallback((assistantIndex: number) => {
    for (let i = assistantIndex - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn.role === 'user') {
        requestAiPrompt({ prompt: turn.text });
        return;
      }
    }
  });

  const hasTurns = turns.length > 0;
  const hasLiveRun = Boolean(
    isStreaming
    || (isLoading && (
      Boolean(activeStage)
      || Boolean(thinkingStage)
      || hasLiveDraft
      || Boolean(toolOutputs.length)
    )),
  );
  const activeThinkingLog = thinkingStartedAt
    ? {
      startedAt: thinkingStartedAt,
      endedAt: thinkingEndedAt,
      steps: thinkingTrace,
    }
    : undefined;

  const renderThinkingDisclosure = (args: {
    log: {
      startedAt: number;
      endedAt?: number;
      steps: AiThinkingTraceStep[];
    };
    title: string;
    keyId: string;
    isLive?: boolean;
    subtitle?: string;
  }) => {
    const { log, title, keyId, isLive, subtitle } = args;
    const isExpanded = expandedThinkingEntries[keyId] ?? Boolean(isLive);
    const summary = isLive
      ? `${title} ${formatAiThinkingDuration((log.endedAt || now) - log.startedAt)}`
      : buildAiThinkingSummary(log).label;
    const stepCount = log.steps.length;
    const progressLabel = isLive
      ? '持续推进中'
      : stepCount
        ? '已完成'
        : '等待中';

    return (
      <div
        className={buildClassName(
          'AiAssistant__thinkingDisclosure',
          'allow-selection',
          isLive && 'is-live',
          isExpanded && 'is-expanded',
        )}
        aria-live={isLive ? 'polite' : undefined}
      >
        <button
          type="button"
          className="AiAssistant__thinkingHeader"
          onClick={() => {
            setExpandedThinkingEntries((current) => ({
              ...current,
              [keyId]: !current[keyId],
            }));
          }}
          aria-expanded={isExpanded}
        >
          <span className="AiAssistant__thinkingHeaderMain">
            <span className="AiAssistant__thinkingDot" />
            <span className="AiAssistant__thinkingHeaderTitle">{summary}</span>
          </span>
          <span className="AiAssistant__thinkingHeaderMeta">
            {progressLabel}
          </span>
          <Icon
            name="down"
            className={buildClassName('AiAssistant__thinkingChevron', isExpanded && 'is-open')}
          />
        </button>

        {subtitle && isExpanded && (
          <div className="AiAssistant__thinkingSubtitle allow-selection">
            <TypingText text={subtitle} isLive={Boolean(isLive)} delayMs={60} />
          </div>
        )}

        {isExpanded && Boolean(stepCount) && (
          <div className="AiAssistant__thinkingSteps allow-selection">
            {log.steps.map((item, idx) => (
              <div key={`${item.createdAt}_${idx}`} className="AiAssistant__thinkingStep">
                <div className="AiAssistant__thinkingStepHeader">
                  <span className="AiAssistant__thinkingStepStage">
                    {THINKING_STAGE_LABELS[item.stage]}
                  </span>
                  <span className="AiAssistant__thinkingStepTitle">
                    {isLive ? (
                      <TypingText
                        text={item.title}
                        isLive
                        className="is-live"
                        delayMs={120 + (idx * 140)}
                      />
                    ) : item.title}
                  </span>
                </div>
                {item.detail && (
                  <div className="AiAssistant__thinkingStepDetail allow-selection">
                    {isLive ? (
                      <TypingText
                        text={item.detail}
                        isLive
                        className="is-live"
                        delayMs={180 + (idx * 140)}
                      />
                    ) : item.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={buildClassName('AiAssistant panel-content', !isActive && 'is-hidden')}>
      {isSupportedChat && (
        <div className={buildClassName('AiAssistant__syncCard', `is-${syncState.status}`)}>
          <div className="AiAssistant__syncHeader">
            <div className="AiAssistant__syncTitle">AI 聊天记录同步</div>
            <div className="AiAssistant__syncStatus">{syncStatusText}</div>
          </div>
          <div className="AiAssistant__syncMetrics">
            <span>
              总消息：
              {syncState.totalMessages || 0}
            </span>
            <span>
              已同步：
              {syncState.syncedMessages}
            </span>
            <span>
              未同步：
              {syncState.unsyncedMessages}
            </span>
          </div>
          <div className="AiAssistant__syncProgressTrack">
            <div className="AiAssistant__syncProgressFill" style={`width: ${syncProgress}%`} />
          </div>
          <div className="AiAssistant__syncOldest">
            最早已同步到：
            {oldestSyncedDateText}
          </div>
          {syncState.error && (
            <div className="AiAssistant__syncError">{syncState.error}</div>
          )}
          <div className="AiAssistant__syncActions">
            {syncState.status === 'syncing' ? (
              <Button
                size="smaller"
                color="translucent"
                onClick={() => pauseChatSync({ chatId, threadId: resolvedThreadId })}
              >
                暂停同步
              </Button>
            ) : (
              <Button
                size="smaller"
                color="primary"
                onClick={() => startChatSync({ chatId, threadId: resolvedThreadId })}
              >
                {syncState.status === 'paused' ? '继续同步' : '开始同步'}
              </Button>
            )}
            <Button
              size="smaller"
              color="translucent"
              disabled={syncState.status === 'syncing'}
              onClick={() => {
                resetChatSync({ chatId, threadId: resolvedThreadId });
                startChatSync({ chatId, threadId: resolvedThreadId });
              }}
            >
              重新同步
            </Button>
            <Button
              size="smaller"
              color="translucent"
              onClick={() => setIsSyncSettingsOpen(true)}
            >
              同步设置
            </Button>
          </div>
        </div>
      )}

      {isSupportedChat && isSyncSettingsOpen && (
        <div
          className="AiAssistant__syncSettingsBackdrop"
          onClick={() => setIsSyncSettingsOpen(false)}
          role="presentation"
        >
          <div
            className="AiAssistant__syncSettings"
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            <div className="AiAssistant__syncSettingsHeader">
              <div className="AiAssistant__syncSettingsTitle">同步设置</div>
              <button
                type="button"
                className="AiAssistant__syncSettingsClose"
                onClick={() => setIsSyncSettingsOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="AiAssistant__syncMethodSelector">
              <label className="AiAssistant__syncMethodOption">
                <input
                  type="radio"
                  name={`chat-sync-method-${chatId}`}
                  checked={syncState.selectedMethod === 'dataExport'}
                  onChange={() => setChatSyncMethod({ chatId, method: 'dataExport' })}
                  disabled={syncState.status === 'syncing'}
                />
                Data Export（推荐）
              </label>
              <label className="AiAssistant__syncMethodOption">
                <input
                  type="radio"
                  name={`chat-sync-method-${chatId}`}
                  checked={syncState.selectedMethod === 'getHistory'}
                  onChange={() => setChatSyncMethod({ chatId, method: 'getHistory' })}
                  disabled={syncState.status === 'syncing'}
                />
                GetHistory（有风险）
              </label>
            </div>

            {syncState.selectedMethod === 'getHistory' && (
              <div className="AiAssistant__syncWarning">
                高频率拉取可能触发 Telegram 反滥用限制，请谨慎使用。
              </div>
            )}

            <div className="AiAssistant__syncRange">
              <label className="AiAssistant__syncRangeLabel" htmlFor={`chat-sync-range-${chatId}`}>
                时间范围
              </label>
              <select
                id={`chat-sync-range-${chatId}`}
                className="AiAssistant__syncRangeSelect"
                value={selectedRangeOption}
                onChange={(e) => handleRangeSelect(e.currentTarget.value as RangeOption)}
                disabled={syncState.status === 'syncing'}
              >
                <option value="all">全部时间</option>
                <option value="today">{PRESET_LABELS.today}</option>
                <option value="yesterday">{PRESET_LABELS.yesterday}</option>
                <option value="thisWeek">{PRESET_LABELS.thisWeek}</option>
                <option value="lastWeek">{PRESET_LABELS.lastWeek}</option>
                <option value="thisMonth">{PRESET_LABELS.thisMonth}</option>
                <option value="custom">自定义</option>
              </select>
            </div>

            {selectedRangeOption === 'custom' && (
              <div className="AiAssistant__syncCustomRange">
                <input
                  className="AiAssistant__syncCustomInput"
                  type="datetime-local"
                  value={toDateTimeLocalValue(customStartAt)}
                  onChange={(e) => {
                    const nextTimestamp = new Date(e.currentTarget.value).getTime();
                    if (!Number.isNaN(nextTimestamp)) {
                      setCustomStartAt(nextTimestamp);
                    }
                  }}
                  disabled={syncState.status === 'syncing'}
                />
                <span className="AiAssistant__syncCustomSeparator">到</span>
                <input
                  className="AiAssistant__syncCustomInput"
                  type="datetime-local"
                  value={toDateTimeLocalValue(customEndAt)}
                  onChange={(e) => {
                    const nextTimestamp = new Date(e.currentTarget.value).getTime();
                    if (!Number.isNaN(nextTimestamp)) {
                      setCustomEndAt(nextTimestamp);
                    }
                  }}
                  disabled={syncState.status === 'syncing'}
                />
                <Button
                  size="smaller"
                  disabled={syncState.status === 'syncing' || customStartAt >= customEndAt}
                  onClick={handleApplyCustomRange}
                >
                  应用
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {!hasApiKey && (
        <div className="AiAssistant__notice">
          <div className="AiAssistant__notice-title">需要先完成 AI 设置</div>
          <div className="AiAssistant__notice-text">
            请先在 AI 设置里填写 API Key，然后再让助手分析当前聊天。
          </div>
          <button
            type="button"
            className="AiAssistant__inline-link"
            onClick={() => openSettingsScreen({ screen: SettingsScreens.Ai })}
          >
            打开 AI 设置
          </button>
        </div>
      )}

      {error && <div className="AiAssistant__error">{error}</div>}

      <div className="AiAssistant__body">
        <div className="AiAssistant__messages custom-scroll">
          {turns.map((turn, index) => (
            (() => {
              const normalizedText = turn.role === 'assistant'
                ? (sanitizeAssistantText(turn.text) || '')
                : turn.text;
              if (!normalizedText.trim()) {
                return undefined;
              }

              return (
                <div
                  key={`${turn.createdAt}_${index}`}
                  className={buildClassName('AiAssistant__message', `is-${turn.role}`)}
                >
                  <div className="AiAssistant__message-role">{turn.role === 'user' ? '你' : 'AI 助手'}</div>
                  {turn.role === 'assistant' && turn.thinkingLog && (
                    renderThinkingDisclosure({
                      log: turn.thinkingLog,
                      title: '已处理',
                      keyId: `${turn.createdAt}_${index}`,
                    })
                  )}
                  <div className="AiAssistant__message-text allow-selection">
                    {turn.role === 'assistant' ? renderAssistantContent(normalizedText) : normalizedText}
                  </div>
                  {turn.role === 'assistant' && (
                    <div className="AiAssistant__message-tools">
                      <button
                        type="button"
                        className="AiAssistant__tool"
                        onClick={() => handleInsert(normalizedText)}
                      >
                        插入
                      </button>
                      <button
                        type="button"
                        className="AiAssistant__tool"
                        onClick={() => handleCopy(normalizedText)}
                      >
                        复制
                      </button>
                      <button
                        type="button"
                        className="AiAssistant__tool"
                        onClick={() => handleRetry(index)}
                      >
                        重试
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          ))}
          {hasLiveRun && (
            <div className="AiAssistant__liveRun AiAssistant__message is-assistant is-live">
              <div className="AiAssistant__liveRunHeader">
                <div className="AiAssistant__liveRunTitle">
                  {streamStatus === 'cancelling'
                    ? '正在中止用户的需求'
                    : '正在处理用户的需求'}
                </div>
                <div className="AiAssistant__statusRow">
                  <span className={buildClassName('AiAssistant__statusBadge', streamStatus && `is-${streamStatus}`)}>
                    {STREAM_STATUS_LABELS[streamStatus || 'idle']}
                  </span>
                  {activeStage && (
                    <span className="AiAssistant__stageBadge">
                      {THINKING_STAGE_LABELS[activeStage]}
                    </span>
                  )}
                </div>
              </div>

              {Boolean((isLoading || isStreaming) && activeThinkingLog) && renderThinkingDisclosure({
                log: activeThinkingLog!,
                title: streamStatus === 'cancelling'
                  ? '正在中止用户的需求'
                  : '正在处理用户的需求',
                keyId: `active-thinking-${thinkingStartedAt || 'now'}`,
                isLive: true,
                subtitle: thinkingStage,
              })}

              {hasLiveDraft && (
                <div className="AiAssistant__liveDraft">
                  <div className="AiAssistant__message-role">草稿答案</div>
                  <div className="AiAssistant__message-text allow-selection">
                    {renderAssistantContent(liveDraftText)}
                  </div>
                </div>
              )}

              {Boolean(toolOutputs.length) && (
                <div className="AiAssistant__toolOutputs">
                  {toolOutputs.slice(-3).map((toolOutput, index) => {
                    const summary = formatToolOutputSummary(toolOutput);
                    return (
                      <div key={`${toolOutput.createdAt}-${index}`} className="AiAssistant__toolCard">
                        <div className="AiAssistant__toolCardTitle">{summary.title}</div>
                        <div className="AiAssistant__toolCardDetail">{summary.detail}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {!hasTurns && !isLoading && !isStreaming && (
            <div className="AiAssistant__empty-state">
              <div className="AiAssistant__empty-copy">
                <div className="AiAssistant__empty-title">可以直接让我处理聊天记录</div>
                <div className="AiAssistant__empty-text">
                  我会读取当前聊天和历史记录，帮你总结、判断任务是否完成、生成回复，或者继续向前补充信息。
                </div>
                <div className="AiAssistant__quick-actions">
                  <button
                    type="button"
                    className="AiAssistant__quick-action"
                    onClick={() => requestAiSummaryToday()}
                    disabled={!hasApiKey || Boolean(isLoading) || isStreaming}
                  >
                    <Icon name="boost" className="AiAssistant__quick-action-icon" />
                    <span className="AiAssistant__quick-action-copy">
                      <span className="AiAssistant__quick-action-title">整理今天</span>
                      <span className="AiAssistant__quick-action-text">提炼今天的聊天结果</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="AiAssistant__quick-action"
                    onClick={() => requestAiReplySuggestions()}
                    disabled={!hasApiKey || Boolean(isLoading) || isStreaming}
                  >
                    <Icon name="boost" className="AiAssistant__quick-action-icon" />
                    <span className="AiAssistant__quick-action-copy">
                      <span className="AiAssistant__quick-action-title">帮我回复</span>
                      <span className="AiAssistant__quick-action-text">生成可直接发送的回话</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="AiAssistant__quick-action"
                    onClick={() => requestAiExtractTodos()}
                    disabled={!hasApiKey || Boolean(isLoading) || isStreaming}
                  >
                    <Icon name="boost" className="AiAssistant__quick-action-icon" />
                    <span className="AiAssistant__quick-action-copy">
                      <span className="AiAssistant__quick-action-title">整理待办</span>
                      <span className="AiAssistant__quick-action-text">提取行动项和跟进项</span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="AiAssistant__composer-shell">
        <div className="AiAssistant__composer-row">
          <div className="AiAssistant__composer-bar">
            <InputText
              className="AiAssistant__composer-input"
              value={prompt}
              placeholder={isStreaming ? 'AI 正在处理，点击右侧可中止' : '输入问题，AI 会自己判断要不要读取聊天记录'}
              disabled={isStreaming}
              onKeyDown={handlePromptKeyDown}
              onChange={(e) => setPrompt(e.currentTarget.value)}
            />
          </div>
          <div className="AiAssistant__composer-actions">
            <button
              type="button"
              className="AiAssistant__clearHistory"
              onClick={handleClearHistory}
              disabled={!hasTurns && !hasLiveRun}
              aria-label="清空历史"
              title="清空历史"
            >
              <Icon name="delete" className="AiAssistant__clearHistory-icon" />
              <span>清空历史</span>
            </button>
            <button
              type="button"
              className={buildClassName('AiAssistant__send is-round', isStreaming && 'is-stop')}
              onClick={handleSendPrompt}
              disabled={isStreaming ? isCancelling : (!hasApiKey || !prompt.trim() || Boolean(isLoading))}
              aria-label={isStreaming ? '中止' : '发送'}
            >
              <Icon name={isStreaming ? 'close' : 'send'} className="AiAssistant__send-icon" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    const tabState = selectTabState(global);
    const {
      turns,
      isLoading,
      streamStatus,
      activeStage,
      draftText,
      finalText,
      toolOutputs,
      thinkingStage,
      thinkingStartedAt,
      thinkingEndedAt,
      thinkingTrace,
      error,
    } = tabState.aiAssistant;

    const hasApiKey = Boolean(global.settings.byKey.aiSettings.apiKey?.trim());

    return {
      chat: selectChat(global, chatId),
      syncState: global.chatSync.byChatId[chatId] || DEFAULT_SYNC_STATE,
      turns,
      isLoading,
      streamStatus,
      activeStage,
      draftText,
      finalText,
      toolOutputs,
      thinkingStage,
      thinkingStartedAt,
      thinkingEndedAt,
      thinkingTrace,
      error,
      hasApiKey,
    };
  },
)(AiAssistant));
