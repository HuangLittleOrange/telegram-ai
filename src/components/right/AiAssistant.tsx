import type { FC } from '@teact';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from '@teact';
import type React from '../../lib/teact/teact';
import type { TeactNode } from '../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../global';

import type { ApiChat } from '../../api/types';
import type { ChatSyncState } from '../../global/types';
import type {
  AiAssistantStreamStatus,
  AiAssistantTurn,
  ToolOutput,
} from '../../global/types/tabState';
import type { ThreadId } from '../../types';
import { MAIN_THREAD_ID } from '../../api/types';
import { SettingsScreens } from '../../types';

import { isChatChannel, isChatGroup } from '../../global/helpers';
import {
  type AiThinkingTraceStep,
  buildAiThinkingSummary,
  formatAiThinkingDuration,
} from '../../global/helpers/aiThinking';
import { resolveTimeRangeBoundsSec } from '../../global/helpers/chatSync';
import {
  selectChat,
  selectTabState,
} from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { formatAiToolOutputSummary } from './helpers/aiToolOutput';
import {
  type MarkdownBlock,
  type MarkdownInlineNode,
  parseMarkdownBlocks,
} from './helpers/markdown';
import {
  loadSyncedHistoryDays,
  loadSyncedHistoryMessages,
  loadSyncedHistorySearchMessages,
  type SyncedHistoryDayItem,
  type SyncedHistoryMessageItem,
} from './helpers/syncedHistoryBrowser';

import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import SafeLink from '../common/SafeLink';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import TextArea from '../ui/TextArea';

import './AiAssistant.scss';

type OwnProps = {
  chatId: string;
  threadId?: ThreadId;
  isActive?: boolean;
};

type StateProps = {
  chat?: ApiChat;
  syncState: ChatSyncState;
  turns: AiAssistantTurn[];
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
  hasAiConfig: boolean;
  selectionContext?: {
    source: 'message-selection';
    chatId: string;
    threadId: ThreadId;
    messageIds: number[];
    createdAt: number;
  };
};

const DEFAULT_SYNC_RANGE_DAYS = 30;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HISTORY_SEARCH_DEBOUNCE_MS = 320;
const CLEARING_HISTORY_NOTICE = '正在清空当前聊天本地记录…';

const DEFAULT_SYNC_STATE: ChatSyncState = {
  selectedMethod: 'dataExport',
  status: 'idle',
  syncedMessages: 0,
  unsyncedMessages: 0,
};
const HIDDEN_ERROR_PATTERNS = [
  /TeactN\.setGlobal/i,
  /outdated global/i,
];

function toDateTimeLocalValue(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatDateOnly(timestamp?: number) {
  if (!timestamp) {
    return '暂无';
  }

  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getStartOfTodayTimestampMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function getDefaultCustomRange() {
  const endAt = Date.now();
  const startAt = endAt - DEFAULT_SYNC_RANGE_DAYS * DAY_IN_MS;
  return { startAt, endAt };
}

function formatTakeoutDelay(seconds: number) {
  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!remainingMinutes) {
    return `${hours} 小时`;
  }

  return `${hours} 小时 ${remainingMinutes} 分钟`;
}

function summarizeSyncErrorDetail(detail?: string, maxLength = 180) {
  if (!detail) {
    return undefined;
  }

  const compact = detail.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return undefined;
  }

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function resolveDisplayedSyncErrorCode(errorCode?: string, detail?: string) {
  const text = `${errorCode || ''} ${detail || ''}`;
  if (/TeactN\.setGlobal|Attempt to set an outdated global|outdated global/i.test(text)) {
    return 'SYNC_STATE_OUTDATED';
  }

  return errorCode;
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
  hasAiConfig,
  selectionContext,
  isActive,
}) => {
  const {
    clearAiSelectionContext,
    openSettingsScreen,
    requestAiExtractTodos,
    cancelAiPrompt,
    requestAiPrompt,
    requestAiReplySuggestions,
    requestAiSummaryToday,
    hydrateAiAssistantSession,
    loadChatSyncStats,
    pauseChatSync,
    clearChatSyncedMessages,
    resetChatSync,
    setChatSyncMethod,
    setChatSyncTimeRange,
    startChatSync,
    focusMessage,
  } = getActions();

  const [prompt, setPrompt] = useState('');
  const [isSyncSettingsOpen, setIsSyncSettingsOpen] = useState(false);
  const [isTakeoutHelpOpen, setIsTakeoutHelpOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [expandedThinkingEntries, setExpandedThinkingEntries] = useState<Record<string, boolean>>({});
  const takeoutHelpShownAtRef = useRef<number | undefined>(undefined);
  const [customStartAt, setCustomStartAt] = useState(() => (
    syncState.selectedTimeRange?.mode === 'custom'
      ? syncState.selectedTimeRange.startAt
      : getDefaultCustomRange().startAt
  ));
  const [isHistoryBrowserOpen, setIsHistoryBrowserOpen] = useState(false);
  const [historyDays, setHistoryDays] = useState<SyncedHistoryDayItem[]>([]);
  const [isHistoryDaysLoading, setIsHistoryDaysLoading] = useState(false);
  const [historyMessages, setHistoryMessages] = useState<SyncedHistoryMessageItem[]>([]);
  const [isHistoryMessagesLoading, setIsHistoryMessagesLoading] = useState(false);
  const [historySearchMessages, setHistorySearchMessages] = useState<SyncedHistoryMessageItem[]>([]);
  const [isHistorySearchLoading, setIsHistorySearchLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | undefined>();
  const [historyNotice, setHistoryNotice] = useState<string | undefined>();
  const [historyDayQuery, setHistoryDayQuery] = useState('');
  const [historyGlobalQuery, setHistoryGlobalQuery] = useState('');
  const [selectedHistoryDayStartSec, setSelectedHistoryDayStartSec] = useState<number | undefined>();
  const [liveDraftVisibleLength, setLiveDraftVisibleLength] = useState(0);
  const isSupportedChat = Boolean(chat && (isChatGroup(chat) || isChatChannel(chat)));
  const resolvedThreadId = threadId || MAIN_THREAD_ID;
  const isStreaming = streamStatus === 'streaming' || streamStatus === 'cancelling';
  const isCancelling = streamStatus === 'cancelling';
  const liveDraftText = streamStatus === 'done'
    ? ''
    : finalText || draftText || '';
  const visibleError = error && HIDDEN_ERROR_PATTERNS.some((pattern) => pattern.test(error))
    ? undefined
    : error;
  const hasLiveDraft = Boolean(liveDraftText.trim());

  useEffect(() => {
    hydrateAiAssistantSession({
      chatId,
      threadId: resolvedThreadId,
    });
  }, [chatId, hydrateAiAssistantSession, resolvedThreadId]);

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
  }, [syncState.selectedTimeRange]);

  useEffect(() => {
    if (!isLoading && !isStreaming && syncState.status !== 'syncing') {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isLoading, isStreaming, syncState.status]);

  useEffect(() => {
    if (!hasLiveDraft) {
      setLiveDraftVisibleLength(0);
      return undefined;
    }

    if (!isStreaming) {
      setLiveDraftVisibleLength(liveDraftText.length);
      return undefined;
    }

    setLiveDraftVisibleLength((current) => Math.min(current, liveDraftText.length));

    const timer = window.setInterval(() => {
      setLiveDraftVisibleLength((current) => {
        if (current >= liveDraftText.length) {
          return current;
        }

        const remaining = liveDraftText.length - current;
        const step = remaining > 48 ? 4 : remaining > 18 ? 2 : 1;
        return Math.min(liveDraftText.length, current + step);
      });
    }, 20);

    return () => window.clearInterval(timer);
  }, [hasLiveDraft, isStreaming, liveDraftText]);

  const syncStatusText = syncState.status === 'syncing'
    ? '同步中'
    : syncState.status === 'clearing'
      ? '清空中'
      : syncState.status === 'paused'
        ? '已暂停'
        : syncState.status === 'completed'
          ? '已完成'
          : syncState.status === 'error'
            ? '同步失败'
            : '待同步';
  const syncedRangeStartTimestamp = syncState.oldestSyncedDate;
  const syncedRangeStartText = formatDateOnly(syncedRangeStartTimestamp);
  const syncedRangeEndText = formatDateOnly(syncState.newestSyncedDate);
  const takeoutDelayText = syncState.takeoutInitDelaySeconds
    ? formatTakeoutDelay(syncState.takeoutInitDelaySeconds)
    : undefined;
  const takeoutRetryAtText = syncState.takeoutInitDelaySeconds
    ? new Date(Date.now() + syncState.takeoutInitDelaySeconds * 1000).toLocaleString()
    : undefined;
  const syncNoProgressSeconds = syncState.status === 'syncing' && syncState.lastProgressAt
    ? Math.max(0, Math.floor((now - syncState.lastProgressAt) / 1000))
    : 0;
  const isSyncBusy = syncState.status === 'syncing' || syncState.status === 'clearing';
  const isClearingHistory = syncState.status === 'clearing';
  const syncErrorDetail = summarizeSyncErrorDetail(syncState.errorDetail);
  const syncErrorCode = resolveDisplayedSyncErrorCode(syncState.errorCode, syncState.errorDetail);
  const historyBounds = resolveTimeRangeBoundsSec(syncState.selectedTimeRange);
  const historyRangeStartSec = historyBounds?.startSec;
  const historyRangeEndSec = historyBounds?.endSec;
  const isRangeScopedSync = syncState.selectedTimeRange?.mode === 'custom';
  const hasReliableScopedTotal = syncState.scopedTotalMessages !== undefined;
  const progressBaseTotal = isRangeScopedSync ? syncState.scopedTotalMessages : syncState.totalMessages;
  const syncProgress = !progressBaseTotal
    ? 0
    : Math.max(0, Math.min(100, Math.round((syncState.syncedMessages / progressBaseTotal) * 100)));
  const latestSyncedTimestamp = syncState.newestSyncedDate || syncState.oldestSyncedDate;
  const isSyncedToToday = Boolean(latestSyncedTimestamp && latestSyncedTimestamp >= getStartOfTodayTimestampMs());
  const composerSyncHint = !hasAiConfig
    ? '✨ 请先完成 AI 设置，然后更新聊天记录再提问。'
    : syncedRangeStartTimestamp && latestSyncedTimestamp
      ? isSyncedToToday
        ? `✨ 当前回答基于 ${syncedRangeStartText} 至 ${syncedRangeEndText} 的已同步聊天记录。`
        : `✨ 当前回答基于 ${syncedRangeStartText} 至 ${syncedRangeEndText} 的已同步聊天记录，请先更新数据以包含今天消息。`
      : latestSyncedTimestamp
        ? isSyncedToToday
          ? `✨ 当前回答基于截至 ${syncedRangeEndText} 的已同步聊天记录。`
          : `✨ 当前回答基于截至 ${syncedRangeEndText} 的已同步聊天记录，请先更新数据以包含今天消息。`
        : '✨ 当前还没有可用聊天记录，请先更新数据。';
  const emptyStateHistoryHint = syncedRangeStartTimestamp && latestSyncedTimestamp
    ? isSyncedToToday
      ? `当前基于 ${syncedRangeStartText} 至 ${syncedRangeEndText} 的已同步聊天记录。`
      : `当前基于 ${syncedRangeStartText} 至 ${syncedRangeEndText} 的已同步聊天记录，请先更新数据以包含今天消息。`
    : latestSyncedTimestamp
      ? isSyncedToToday
        ? `当前基于截至 ${syncedRangeEndText} 的已同步聊天记录。`
        : `当前基于截至 ${syncedRangeEndText} 的已同步聊天记录，请先更新数据以包含今天消息。`
      : '当前还没有可用聊天记录，请先更新数据。';
  const normalizedHistoryGlobalQuery = historyGlobalQuery.trim();
  const isHistoryGlobalSearchActive = Boolean(normalizedHistoryGlobalQuery);
  const selectedHistoryDay = selectedHistoryDayStartSec === undefined
    ? undefined
    : historyDays.find((day) => day.dayStartSec === selectedHistoryDayStartSec);
  const historySearchDayItems = useMemo(() => {
    if (!isHistoryGlobalSearchActive) {
      return [];
    }

    const byDayKey = new Map<string, SyncedHistoryDayItem>();
    historySearchMessages.forEach((message) => {
      const existing = byDayKey.get(message.dayKey);
      if (existing) {
        existing.count += 1;
        return;
      }

      byDayKey.set(message.dayKey, {
        dayKey: message.dayKey,
        dayStartSec: message.dayStartSec,
        count: 1,
        label: message.dayLabel,
      });
    });

    return Array.from(byDayKey.values())
      .sort((left, right) => right.dayStartSec - left.dayStartSec);
  }, [historySearchMessages, isHistoryGlobalSearchActive]);
  const filteredHistoryDays = useMemo(() => {
    const normalizedQuery = historyDayQuery.trim().toLowerCase();
    const sourceDays = isHistoryGlobalSearchActive ? historySearchDayItems : historyDays;

    if (!normalizedQuery) {
      return sourceDays;
    }

    return sourceDays.filter((day) => (
      day.dayKey.toLowerCase().includes(normalizedQuery)
      || day.label.toLowerCase().includes(normalizedQuery)
    ));
  }, [historyDayQuery, historyDays, historySearchDayItems, isHistoryGlobalSearchActive]);
  const visibleHistoryMessages = useMemo(() => {
    if (isHistoryGlobalSearchActive) {
      return selectedHistoryDayStartSec === undefined
        ? historySearchMessages
        : historySearchMessages.filter((message) => message.dayStartSec === selectedHistoryDayStartSec);
    }

    return historyMessages;
  }, [historyMessages, historySearchMessages, isHistoryGlobalSearchActive, selectedHistoryDayStartSec]);

  useEffect(() => {
    takeoutHelpShownAtRef.current = undefined;
    setIsTakeoutHelpOpen(false);
    setIsHistoryBrowserOpen(false);
    setHistoryDays([]);
    setHistoryMessages([]);
    setHistorySearchMessages([]);
    setHistoryError(undefined);
    setHistoryNotice(undefined);
    setHistoryDayQuery('');
    setHistoryGlobalQuery('');
    setSelectedHistoryDayStartSec(undefined);
  }, [chatId]);

  useEffect(() => {
    if (!isHistoryBrowserOpen || !isSupportedChat) {
      return undefined;
    }

    let isCancelled = false;
    setIsHistoryDaysLoading(true);
    setHistoryError(undefined);
    setHistoryNotice(undefined);

    void loadSyncedHistoryDays({
      chatId,
      threadId: resolvedThreadId,
      timeRange: historyRangeStartSec !== undefined && historyRangeEndSec !== undefined
        ? {
          startSec: historyRangeStartSec,
          endSec: historyRangeEndSec,
        }
        : undefined,
    }).then((days) => {
      if (isCancelled) {
        return;
      }

      setHistoryDays(days);
      setHistoryDayQuery('');
      setSelectedHistoryDayStartSec((current) => (
        current !== undefined && days.some((day) => day.dayStartSec === current)
          ? current
          : undefined
      ));
      if (!days.length) {
        setHistoryNotice('当前时间范围内还没有本地已同步消息');
      }
    }).catch(() => {
      if (isCancelled) {
        return;
      }

      setHistoryError('读取按日聊天记录失败');
      setHistoryNotice(undefined);
      setHistoryDays([]);
    }).finally(() => {
      if (!isCancelled) {
        setIsHistoryDaysLoading(false);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [
    chatId,
    historyRangeEndSec,
    historyRangeStartSec,
    isHistoryBrowserOpen,
    isSupportedChat,
    resolvedThreadId,
  ]);

  useEffect(() => {
    if (!isHistoryBrowserOpen || isHistoryGlobalSearchActive || selectedHistoryDayStartSec === undefined) {
      return undefined;
    }

    let isCancelled = false;
    setIsHistoryMessagesLoading(true);
    setHistoryError(undefined);
    setHistoryNotice(undefined);

    void loadSyncedHistoryMessages({
      global: getGlobal(),
      chatId,
      threadId: resolvedThreadId,
      dayStartSec: selectedHistoryDayStartSec,
    }).then((messages) => {
      if (isCancelled) {
        return;
      }

      setHistoryMessages(messages);
      if (!messages.length) {
        setHistoryNotice('这一天还没有本地已同步消息');
      }
    }).catch(() => {
      if (isCancelled) {
        return;
      }

      setHistoryError('读取当天聊天记录失败');
      setHistoryNotice(undefined);
      setHistoryMessages([]);
    }).finally(() => {
      if (!isCancelled) {
        setIsHistoryMessagesLoading(false);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [chatId, isHistoryBrowserOpen, isHistoryGlobalSearchActive, resolvedThreadId, selectedHistoryDayStartSec]);

  useEffect(() => {
    if (!isHistoryBrowserOpen) {
      return undefined;
    }

    if (!normalizedHistoryGlobalQuery) {
      setIsHistorySearchLoading(false);
      setHistorySearchMessages([]);
      setHistoryNotice(undefined);
      return undefined;
    }

    let isCancelled = false;
    setHistoryError(undefined);
    setHistoryNotice(undefined);

    const timer = window.setTimeout(() => {
      if (isCancelled) {
        return;
      }

      setIsHistorySearchLoading(true);
      void loadSyncedHistorySearchMessages({
        global: getGlobal(),
        chatId,
        threadId: resolvedThreadId,
        keyword: normalizedHistoryGlobalQuery,
        timeRange: historyRangeStartSec !== undefined && historyRangeEndSec !== undefined
          ? {
            startSec: historyRangeStartSec,
            endSec: historyRangeEndSec,
          }
          : undefined,
      }).then((messages) => {
        if (isCancelled) {
          return;
        }

        setHistorySearchMessages(messages);
        setSelectedHistoryDayStartSec((current) => (
          current !== undefined && messages.some((message) => message.dayStartSec === current)
            ? current
            : undefined
        ));
        if (!messages.length) {
          setHistoryNotice('当前范围内没有匹配这个关键词的本地聊天记录');
        }
      }).catch(() => {
        if (isCancelled) {
          return;
        }

        setHistoryError('读取全局搜索结果失败');
        setHistoryNotice(undefined);
        setHistorySearchMessages([]);
      }).finally(() => {
        if (!isCancelled) {
          setIsHistorySearchLoading(false);
        }
      });
    }, HISTORY_SEARCH_DEBOUNCE_MS);

    return () => {
      isCancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    chatId,
    historyRangeEndSec,
    historyRangeStartSec,
    isHistoryBrowserOpen,
    normalizedHistoryGlobalQuery,
    resolvedThreadId,
  ]);

  useEffect(() => {
    if (!syncState.requiresTakeoutAuthorization || syncState.status !== 'error') {
      return;
    }

    if (takeoutHelpShownAtRef.current === syncState.updatedAt) {
      return;
    }

    takeoutHelpShownAtRef.current = syncState.updatedAt;
    setIsTakeoutHelpOpen(true);
  }, [syncState.requiresTakeoutAuthorization, syncState.status, syncState.updatedAt]);

  const previousSyncStatusRef = useRef(syncState.status);
  useEffect(() => {
    const previousStatus = previousSyncStatusRef.current;
    previousSyncStatusRef.current = syncState.status;

    if (previousStatus !== 'clearing' || syncState.status === 'clearing') {
      return;
    }

    if (syncState.status === 'error') {
      setHistoryError(syncState.error || '清空本地记录失败，请稍后重试');
      setHistoryNotice(undefined);
      return;
    }

    setHistoryError(undefined);
    setHistoryNotice('已清空当前聊天的本地同步记录。');
  }, [syncState.error, syncState.status]);

  const applyCustomStartTime = useLastCallback((startAt: number) => {
    const normalizedEndAt = Date.now();
    if (!startAt || !normalizedEndAt || startAt >= normalizedEndAt) {
      return;
    }

    setChatSyncTimeRange({
      chatId,
      timeRange: {
        mode: 'custom',
        startAt,
        endAt: normalizedEndAt,
      },
    });
  });

  const closeHistoryBrowser = useLastCallback(() => {
    setIsHistoryBrowserOpen(false);
    if (syncState.status === 'syncing') {
      pauseChatSync({ chatId, threadId: resolvedThreadId });
    }
  });

  const handleClearSyncedHistory = useLastCallback(() => {
    if (isClearingHistory) {
      return;
    }

    if (!window.confirm('确认清空当前聊天的本地已同步记录吗？此操作不可撤销。')) {
      return;
    }

    setHistoryError(undefined);
    setHistoryNotice(CLEARING_HISTORY_NOTICE);
    setSelectedHistoryDayStartSec(undefined);
    setHistoryDayQuery('');
    setHistoryGlobalQuery('');
    setHistoryDays([]);
    setHistoryMessages([]);
    setHistorySearchMessages([]);
    clearChatSyncedMessages({
      chatId,
      threadId: resolvedThreadId,
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

  const handlePromptKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isComposing = Boolean(e.isComposing || e.nativeEvent?.isComposing);
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      e.preventDefault();
      if (isStreaming) {
        cancelAiPrompt();
        return;
      }
      handleSendPrompt();
    }
  });

  const hasTurns = turns.length > 0 || Boolean(visibleError);
  const liveDraftAnimatedText = hasLiveDraft && isStreaming
    ? liveDraftText.slice(0, liveDraftVisibleLength)
    : liveDraftText;
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
              <div
                key={`${item.createdAt}_${item.stage}_${item.title}_${item.detail || ''}`}
                className="AiAssistant__thinkingStep"
              >
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
                  disabled={isSyncBusy}
                />
                Data Export（推荐）
              </label>
              <label className="AiAssistant__syncMethodOption">
                <input
                  type="radio"
                  name={`chat-sync-method-${chatId}`}
                  checked={syncState.selectedMethod === 'getHistory'}
                  onChange={() => setChatSyncMethod({ chatId, method: 'getHistory' })}
                  disabled={isSyncBusy}
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
              <label className="AiAssistant__syncRangeLabel" htmlFor={`chat-sync-start-${chatId}`}>
                开始时间
              </label>
              <div className="AiAssistant__syncRangeHint">
                结束时间固定为现在（今天），只需选择起始时间。
              </div>
            </div>

            <div className="AiAssistant__syncCustomRange">
              <input
                id={`chat-sync-start-${chatId}`}
                className="AiAssistant__syncCustomInput"
                type="datetime-local"
                value={toDateTimeLocalValue(customStartAt)}
                max={toDateTimeLocalValue(Date.now())}
                onChange={(e) => {
                  const nextTimestamp = new Date(e.currentTarget.value).getTime();
                  if (!Number.isNaN(nextTimestamp)) {
                    setCustomStartAt(nextTimestamp);
                    applyCustomStartTime(nextTimestamp);
                  }
                }}
                disabled={isSyncBusy}
              />
            </div>
            <div className="AiAssistant__syncSettingsActions">
              <Button
                size="smaller"
                color="translucent"
                disabled={isSyncBusy}
                onClick={() => {
                  resetChatSync({ chatId, threadId: resolvedThreadId });
                  startChatSync({ chatId, threadId: resolvedThreadId });
                }}
              >
                重新同步
              </Button>
            </div>
          </div>
        </div>
      )}

      {isSupportedChat && isTakeoutHelpOpen && syncState.requiresTakeoutAuthorization && (
        <div
          className="AiAssistant__syncSettingsBackdrop AiAssistant__takeoutHelpBackdrop"
          onClick={() => setIsTakeoutHelpOpen(false)}
          role="presentation"
        >
          <div
            className="AiAssistant__takeoutHelp"
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            <div className="AiAssistant__takeoutHelpHeader">
              <div className="AiAssistant__takeoutHelpTitle">Data Export 需要授权确认</div>
              <button
                type="button"
                className="AiAssistant__syncSettingsClose"
                onClick={() => setIsTakeoutHelpOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="AiAssistant__takeoutHelpBody">
              <div className="AiAssistant__takeoutHelpText">
                Telegram 会对 Data Export 做安全校验，请先在官方客户端确认导出请求。
              </div>
              {takeoutDelayText && (
                <div className="AiAssistant__takeoutHelpText">
                  当前建议等待约
                  {' '}
                  <strong>{takeoutDelayText}</strong>
                  {' '}
                  后重试（约
                  {' '}
                  <strong>{takeoutRetryAtText}</strong>
                  {' '}
                  ）。
                </div>
              )}
              <div className="AiAssistant__takeoutHelpSteps">
                <div className="AiAssistant__takeoutHelpStep">1. 在手机或 Telegram Desktop 打开同一账号。</div>
                <div className="AiAssistant__takeoutHelpStep">2. 查看 Telegram 的安全通知或服务消息并确认授权。</div>
                <div className="AiAssistant__takeoutHelpStep">3. 回到这里点击“重新同步”。</div>
              </div>
              <div className="AiAssistant__takeoutHelpHint">
                如果没收到通知，请保持官方客户端在线几分钟后再试一次。
              </div>
            </div>
            <div className="AiAssistant__takeoutHelpActions">
              <Button
                size="smaller"
                color="translucent"
                onClick={() => setIsTakeoutHelpOpen(false)}
              >
                我知道了
              </Button>
              <Button
                size="smaller"
                color="primary"
                onClick={() => {
                  setIsTakeoutHelpOpen(false);
                  resetChatSync({ chatId, threadId: resolvedThreadId });
                  startChatSync({ chatId, threadId: resolvedThreadId });
                }}
              >
                重新同步
              </Button>
            </div>
          </div>
        </div>
      )}

      {isSupportedChat && (
        <Modal
          isOpen={isHistoryBrowserOpen}
          onClose={closeHistoryBrowser}
          title="按日期查看聊天记录"
          hasCloseButton
          className="AiAssistant__historyModal"
          contentClassName="AiAssistant__historyModalContent"
          dialogClassName="AiAssistant__historyModalDialog"
        >
          <div className="AiAssistant__historyBrowser">
            <div className={buildClassName('AiAssistant__historySyncBar', `is-${syncState.status}`)}>
              <div className="AiAssistant__historySyncTop">
                <div className="AiAssistant__historySyncStatus">
                  同步状态：
                  {' '}
                  {syncStatusText}
                </div>
                <div className="AiAssistant__historySyncCount">
                  已同步
                  {' '}
                  {syncState.syncedMessages}
                  {' '}
                  /
                  {' '}
                  {progressBaseTotal || syncState.totalMessages || 0}
                </div>
              </div>
              {(!isRangeScopedSync || hasReliableScopedTotal) && (
                <div className="AiAssistant__syncProgressTrack">
                  <div className="AiAssistant__syncProgressFill" style={`width: ${syncProgress}%`} />
                </div>
              )}
              <div className="AiAssistant__historySyncMeta">
                已同步时间：
                {' '}
                {syncedRangeStartText}
                {' '}
                至
                {' '}
                {syncedRangeEndText}
              </div>
              {syncState.status === 'syncing' && syncNoProgressSeconds >= 10 && (
                <div className="AiAssistant__syncHint">
                  {syncNoProgressSeconds >= 45
                    ? `同步可能卡住（${syncNoProgressSeconds} 秒无进展），建议暂停后继续同步`
                    : `正在同步中，最近 ${syncNoProgressSeconds} 秒无新增进展`}
                </div>
              )}
              {syncState.error && (
                <div className="AiAssistant__syncError">
                  <div>{syncState.error}</div>
                  {syncErrorCode && (
                    <div className="AiAssistant__syncErrorCode">
                      错误码：
                      {' '}
                      {syncErrorCode}
                    </div>
                  )}
                  {syncErrorDetail && (
                    <div className="AiAssistant__syncErrorDetail">
                      详情：
                      {' '}
                      {syncErrorDetail}
                    </div>
                  )}
                </div>
              )}
              <div className="AiAssistant__historySyncActions">
                <Button
                  className="AiAssistant__historySyncAction AiAssistant__historySyncAction--primary"
                  size="tiny"
                  color={syncState.status === 'syncing' || syncState.status === 'clearing' ? 'translucent' : 'primary'}
                  disabled={syncState.status === 'clearing'}
                  onClick={() => {
                    if (syncState.status === 'syncing') {
                      pauseChatSync({ chatId, threadId: resolvedThreadId });
                      return;
                    }
                    if (syncState.status === 'clearing') {
                      return;
                    }
                    startChatSync({ chatId, threadId: resolvedThreadId });
                  }}
                >
                  {syncState.status === 'syncing'
                    ? '暂停同步'
                    : syncState.status === 'clearing'
                      ? '清空中...'
                      : '开始同步'}
                </Button>
                <Button
                  className="AiAssistant__historySyncAction AiAssistant__historySyncAction--danger"
                  size="tiny"
                  color="danger"
                  isText
                  disabled={isClearingHistory}
                  onClick={handleClearSyncedHistory}
                >
                  {isClearingHistory ? '清空中...' : '清空本地记录'}
                </Button>
              </div>
              <div className="AiAssistant__historySyncActionHint">
                仅清空当前聊天的本地同步记录，不会删除 Telegram 原始消息。
              </div>
              {syncState.requiresTakeoutAuthorization && syncState.status === 'error' && (
                <button
                  type="button"
                  className="AiAssistant__syncErrorAction"
                  onClick={() => setIsTakeoutHelpOpen(true)}
                >
                  查看授权指引
                </button>
              )}
            </div>

            <div className="AiAssistant__historyBrowserHeader">
              {selectedHistoryDay ? (
                <button
                  type="button"
                  className="AiAssistant__historyBack"
                  onClick={() => {
                    setSelectedHistoryDayStartSec(undefined);
                    if (!isHistoryGlobalSearchActive) {
                      setHistoryMessages([]);
                    }
                    setHistoryError(undefined);
                    setHistoryNotice(undefined);
                  }}
                >
                  {isHistoryGlobalSearchActive ? '清除日期筛选' : '返回日期列表'}
                </button>
              ) : (
                <div className="AiAssistant__historyTitle">按日期查看聊天记录</div>
              )}
              <div className="AiAssistant__historyMeta">
                当前范围本地已同步
                {' '}
                {syncState.syncedMessages}
                {' '}
                条
              </div>
            </div>

            <div className="AiAssistant__historyGlobalSearchBar">
              <input
                type="search"
                className="AiAssistant__historySearch is-global"
                value={historyGlobalQuery}
                placeholder="搜索当前范围内的全部聊天记录关键词"
                onChange={(e) => setHistoryGlobalQuery(e.currentTarget.value)}
              />
              <div className="AiAssistant__historySearchHint">
                {isHistoryGlobalSearchActive
                  ? '正在全局搜索本地历史记录，可继续点左侧日期缩小范围。'
                  : '这里的搜索会检索当前时间范围内的全部本地历史记录。'}
              </div>
            </div>

            {historyError && (
              <div className="AiAssistant__historyEmpty is-error">
                {historyError}
              </div>
            )}

            {!historyError && historyNotice && (
              <div className="AiAssistant__historyEmpty">
                {historyNotice}
              </div>
            )}

            {!historyError && (
              <div className="AiAssistant__historyBrowserGrid">
                <div className="AiAssistant__historyPane is-days">
                  <input
                    type="search"
                    className="AiAssistant__historySearch"
                    value={historyDayQuery}
                    placeholder="搜索日期，如 2026-04-11"
                    onChange={(e) => setHistoryDayQuery(e.currentTarget.value)}
                  />
                  <div className="AiAssistant__historyDayList">
                    {isHistoryDaysLoading ? (
                      <div className="AiAssistant__historyEmpty">正在读取日期列表...</div>
                    ) : filteredHistoryDays.length ? filteredHistoryDays.map((day) => (
                      <button
                        type="button"
                        key={day.dayKey}
                        className="AiAssistant__historyDay"
                        onClick={() => setSelectedHistoryDayStartSec(day.dayStartSec)}
                      >
                        <span className="AiAssistant__historyDayLabel">{day.label}</span>
                        <span className="AiAssistant__historyDayCount">
                          {day.count}
                          {' '}
                          条
                        </span>
                      </button>
                    )) : (
                      <div className="AiAssistant__historyEmpty">没有匹配这个日期的本地记录</div>
                    )}
                  </div>
                </div>

                <div className="AiAssistant__historyPane is-messages">
                  {selectedHistoryDay || isHistoryGlobalSearchActive ? (
                    <>
                      <div className="AiAssistant__historyPaneTop">
                        <div className="AiAssistant__historyDayHeading">
                          {isHistoryGlobalSearchActive
                            ? selectedHistoryDay
                              ? `${selectedHistoryDay.label} · 搜索结果 ${visibleHistoryMessages.length} 条`
                              : `全局搜索结果 · ${visibleHistoryMessages.length} 条`
                            : `${selectedHistoryDay?.label || ''} · ${selectedHistoryDay?.count || 0} 条`}
                        </div>
                        {isHistoryGlobalSearchActive && (
                          <div className="AiAssistant__historyPaneHint">
                            显示当前范围内匹配关键词的历史消息，按时间倒序排列。
                          </div>
                        )}
                      </div>
                      <div className="AiAssistant__historyMessages">
                        {isHistoryGlobalSearchActive ? (
                          isHistorySearchLoading ? (
                            <div className="AiAssistant__historyEmpty">正在搜索全部聊天记录...</div>
                          ) : visibleHistoryMessages.length ? visibleHistoryMessages.map((message) => (
                            <button
                              type="button"
                              key={message.messageId}
                              className="AiAssistant__historyMessage"
                              onClick={() => {
                                closeHistoryBrowser();
                                focusMessage({
                                  chatId,
                                  messageId: message.messageId,
                                  scrollTargetPosition: 'centerOrTop',
                                });
                              }}
                            >
                              <div className="AiAssistant__historyMessageMeta">
                                <span>
                                  {message.dayLabel}
                                  {' '}
                                  {message.timeText}
                                </span>
                                <span>{message.sender}</span>
                              </div>
                              <div className="AiAssistant__historyMessageText">
                                {message.text}
                              </div>
                            </button>
                          )) : (
                            <div className="AiAssistant__historyEmpty">当前范围内没有匹配这个关键词的本地聊天记录</div>
                          )
                        ) : isHistoryMessagesLoading ? (
                          <div className="AiAssistant__historyEmpty">正在读取当天消息...</div>
                        ) : visibleHistoryMessages.length ? visibleHistoryMessages.map((message) => (
                          <button
                            type="button"
                            key={message.messageId}
                            className="AiAssistant__historyMessage"
                            onClick={() => {
                              closeHistoryBrowser();
                              focusMessage({
                                chatId,
                                messageId: message.messageId,
                                scrollTargetPosition: 'centerOrTop',
                              });
                            }}
                          >
                            <div className="AiAssistant__historyMessageMeta">
                              <span>{message.timeText}</span>
                              <span>{message.sender}</span>
                            </div>
                            <div className="AiAssistant__historyMessageText">
                              {message.text}
                            </div>
                          </button>
                        )) : (
                          <div className="AiAssistant__historyEmpty">这一天还没有本地已同步消息</div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="AiAssistant__historyEmpty">
                      从左侧选择一个日期，就能查看当天的本地聊天记录。
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {!hasAiConfig && (
        <div className="AiAssistant__notice">
          <div className="AiAssistant__notice-title">需要先完成 AI 设置</div>
          <div className="AiAssistant__notice-text">
            请先在 AI 设置里至少填写一个参数（Model ID / API Key / Base URL），然后再让助手分析当前聊天。
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

      <div className="AiAssistant__body">
        <div className="AiAssistant__messages custom-scroll">
          {turns.map((turn, index) => (
            (() => {
              const normalizedText = turn.text;
              if (!normalizedText.trim()) {
                return undefined;
              }

              return (
                <div
                  key={`${turn.createdAt}_${index}`}
                  className={buildClassName('AiAssistant__message', `is-${turn.role}`)}
                >
                  {turn.role === 'assistant' && turn.thinkingLog && (
                    renderThinkingDisclosure({
                      log: turn.thinkingLog,
                      title: '已处理',
                      keyId: `${turn.createdAt}_${index}`,
                    })
                  )}
                  {Boolean(turn.role === 'user' && turn.attachedMessageCount) && (
                    <div className="AiAssistant__message-attachment">
                      {`已附加 ${turn.attachedMessageCount} 条消息`}
                    </div>
                  )}
                  <div className="AiAssistant__message-text allow-selection">
                    {turn.role === 'assistant' ? renderAssistantContent(normalizedText) : normalizedText}
                  </div>
                </div>
              );
            })()
          ))}
          {visibleError && (
            <div className="AiAssistant__message is-assistant is-error">
              <div className="AiAssistant__message-text allow-selection">
                {visibleError}
              </div>
            </div>
          )}
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
                    {renderAssistantContent(liveDraftAnimatedText)}
                    {isStreaming && (
                      <span className="AiAssistant__typingCaret" aria-hidden="true" />
                    )}
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
                {hasAiConfig ? (
                  <>
                    <div className="AiAssistant__empty-title">我会基于已同步聊天记录帮你处理</div>
                    <div className="AiAssistant__empty-text">
                      {emptyStateHistoryHint}
                      {' '}
                      我可以帮你总结、判断任务是否完成、生成回复，或者继续向前补充信息。
                    </div>
                    {isSupportedChat && (
                      <button
                        type="button"
                        className="AiAssistant__empty-link"
                        onClick={() => setIsHistoryBrowserOpen(true)}
                      >
                        想要更好的结果？去同步更多聊天记录
                      </button>
                    )}
                    <div className="AiAssistant__quick-actions">
                      <button
                        type="button"
                        className="AiAssistant__quick-action"
                        onClick={() => requestAiSummaryToday()}
                        disabled={!hasAiConfig || Boolean(isLoading) || isStreaming}
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
                        disabled={!hasAiConfig || Boolean(isLoading) || isStreaming}
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
                        disabled={!hasAiConfig || Boolean(isLoading) || isStreaming}
                      >
                        <Icon name="boost" className="AiAssistant__quick-action-icon" />
                        <span className="AiAssistant__quick-action-copy">
                          <span className="AiAssistant__quick-action-title">整理待办</span>
                          <span className="AiAssistant__quick-action-text">提取行动项和跟进项</span>
                        </span>
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="AiAssistant__empty-title">请先完成 AI 设置</div>
                    <div className="AiAssistant__empty-text">
                      先配置 Model ID / API Key / Base URL，然后再让助手基于聊天记录帮你分析与生成回复。
                    </div>
                    <button
                      type="button"
                      className="AiAssistant__quick-action"
                      onClick={() => openSettingsScreen({ screen: SettingsScreens.Ai })}
                    >
                      <Icon name="settings" className="AiAssistant__quick-action-icon" />
                      <span className="AiAssistant__quick-action-copy">
                        <span className="AiAssistant__quick-action-title">打开 AI 设置</span>
                        <span className="AiAssistant__quick-action-text">完成配置后即可开始提问</span>
                      </span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="AiAssistant__composer-shell">
        <div className="AiAssistant__composer-bar">
          {selectionContext && (
            <div className="AiAssistant__selectionContext">
              <div className="AiAssistant__selectionContextCopy">
                <div className="AiAssistant__selectionContextTitle">
                  {`已附加 ${selectionContext.messageIds.length} 条消息`}
                </div>
              </div>
              <button
                type="button"
                className="AiAssistant__selectionContextAction"
                onClick={() => clearAiSelectionContext()}
              >
                清除
              </button>
            </div>
          )}
          <div className="AiAssistant__composer-row">
            <TextArea
              className="AiAssistant__composer-input"
              value={prompt}
              placeholder={hasAiConfig ? '输入问题…' : '请先完成 AI 设置'}
              disabled={isStreaming || !hasAiConfig}
              noReplaceNewlines
              onKeyDown={handlePromptKeyDown}
              onChange={(e) => setPrompt(e.currentTarget.value)}
            />
          </div>
          <div className="AiAssistant__composer-actions">
            <button
              type="button"
              className={buildClassName('AiAssistant__send is-round', isStreaming && 'is-stop')}
              onClick={handleSendPrompt}
              disabled={isStreaming ? isCancelling : (!hasAiConfig || !prompt.trim() || Boolean(isLoading))}
              aria-label={isStreaming ? '中止' : '发送'}
            >
              <Icon name={isStreaming ? 'close' : 'up'} className="AiAssistant__send-icon" />
            </button>
          </div>
        </div>
        {isStreaming && (
          <div className="AiAssistant__composer-status">正在处理，可点发送按钮中止</div>
        )}
        {isSupportedChat && (
          <div className="AiAssistant__composer-hint">
            <span>{composerSyncHint}</span>
            <button
              type="button"
              className="AiAssistant__composer-hint-link"
              onClick={() => setIsHistoryBrowserOpen(true)}
            >
              更新数据
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    const tabState = selectTabState(global);
    const chat = selectChat(global, chatId);
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
      selectionContext,
    } = tabState.aiAssistant;

    const aiSettings = global.settings.byKey.aiSettings;
    const hasAiConfig = Boolean(
      aiSettings.model?.trim()
      || aiSettings.apiKey?.trim()
      || aiSettings.baseUrl?.trim(),
    );

    return {
      chat,
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
      hasAiConfig,
      selectionContext,
    };
  },
)(AiAssistant));
