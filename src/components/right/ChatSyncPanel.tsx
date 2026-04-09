import { memo, useEffect, useMemo, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiChat } from '../../api/types';
import type { ChatSyncState } from '../../global/types';
import type { TimeRange } from '../../global/types/tabState';
import type { ThreadId } from '../../types';
import { MAIN_THREAD_ID } from '../../api/types';

import { isChatChannel, isChatGroup } from '../../global/helpers';
import { selectChat } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';

import Button from '../ui/Button';

import './ChatSyncPanel.scss';

type OwnProps = {
  chatId: string;
  threadId?: ThreadId;
};

type StateProps = {
  chat?: ApiChat;
  syncState: ChatSyncState;
};

type RangeOption = 'all' | 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'custom';

const PRESET_LABELS: Record<Exclude<RangeOption, 'all' | 'custom'>, string> = {
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  lastWeek: '上周',
  thisMonth: '本月',
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

const ChatSyncPanel = ({
  chatId,
  threadId,
  chat,
  syncState,
}: OwnProps & StateProps) => {
  const {
    loadChatSyncStats,
    setChatSyncMethod,
    setChatSyncTimeRange,
    startChatSync,
    pauseChatSync,
    resetChatSync,
  } = getActions();

  const isSupportedChat = Boolean(chat && (isChatGroup(chat) || isChatChannel(chat)));
  const resolvedThreadId = threadId || MAIN_THREAD_ID;
  const selectedRangeOption = getRangeOption(syncState.selectedTimeRange);

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

  useEffect(() => {
    if (!isSupportedChat) return;
    loadChatSyncStats({ chatId, threadId: resolvedThreadId });
  }, [chatId, isSupportedChat, loadChatSyncStats, resolvedThreadId]);

  useEffect(() => {
    if (syncState.selectedTimeRange?.mode !== 'custom') {
      return;
    }

    setCustomStartAt(syncState.selectedTimeRange.startAt);
    setCustomEndAt(syncState.selectedTimeRange.endAt);
  }, [syncState.selectedTimeRange]);

  const progress = useMemo(() => {
    if (!syncState.totalMessages) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round((syncState.syncedMessages / syncState.totalMessages) * 100)));
  }, [syncState.syncedMessages, syncState.totalMessages]);

  const statusText = useMemo(() => {
    switch (syncState.status) {
      case 'syncing':
        return '同步中';
      case 'paused':
        return '已暂停';
      case 'completed':
        return '已完成';
      case 'error':
        return '同步失败';
      case 'idle':
      default:
        return '待同步';
    }
  }, [syncState.status]);

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

  const handleApplyCustomRange = () => {
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
  };

  if (!isSupportedChat) {
    return undefined;
  }

  return (
    <div className="ChatSyncPanel">
      <div className="header">
        <div className="title">聊天同步状态</div>
        <div className={buildClassName('status', `is-${syncState.status}`)}>{statusText}</div>
      </div>

      <div className="method-selector">
        <label className="method-option">
          <input
            type="radio"
            name={`chat-sync-method-${chatId}`}
            checked={syncState.selectedMethod === 'dataExport'}
            onChange={() => setChatSyncMethod({ chatId, method: 'dataExport' })}
            disabled={syncState.status === 'syncing'}
          />
          Data Export（推荐）
        </label>
        <label className="method-option">
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
        <div className="warning">
          高频率拉取可能触发 Telegram 反滥用限制，请谨慎使用。
        </div>
      )}

      <div className="range-selector">
        <label className="range-label" htmlFor={`chat-sync-range-${chatId}`}>时间范围</label>
        <select
          id={`chat-sync-range-${chatId}`}
          className="range-select"
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
        <div className="custom-range">
          <input
            className="custom-input"
            type="datetime-local"
            value={toDateTimeLocalValue(customStartAt)}
            onChange={(e) => setCustomStartAt(new Date(e.currentTarget.value).getTime())}
            disabled={syncState.status === 'syncing'}
          />
          <span className="custom-separator">到</span>
          <input
            className="custom-input"
            type="datetime-local"
            value={toDateTimeLocalValue(customEndAt)}
            onChange={(e) => setCustomEndAt(new Date(e.currentTarget.value).getTime())}
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

      <div className="metrics">
        <div className="metric-card">
          <span className="label">总消息数</span>
          <span className="value">{syncState.totalMessages || 0}</span>
        </div>
        <div className="metric-card is-synced">
          <span className="label">已同步消息</span>
          <span className="value">{syncState.syncedMessages}</span>
        </div>
        <div className="metric-card">
          <span className="label">未同步消息</span>
          <span className="value">{syncState.unsyncedMessages}</span>
        </div>
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={`width: ${progress}%`} />
      </div>

      <div className="oldest">
        最老已同步消息日期：
        {oldestSyncedDateText}
      </div>

      {syncState.error && (
        <div className="error">{syncState.error}</div>
      )}

      <div className="actions">
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
          onClick={() => {
            resetChatSync({ chatId, threadId: resolvedThreadId });
            startChatSync({ chatId, threadId: resolvedThreadId });
          }}
          disabled={syncState.status === 'syncing'}
        >
          重新同步
        </Button>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): StateProps => {
    return {
      chat: selectChat(global, chatId),
      syncState: global.chatSync.byChatId[chatId] || {
        selectedMethod: 'dataExport',
        status: 'idle',
        syncedMessages: 0,
        unsyncedMessages: 0,
      },
    };
  },
)(ChatSyncPanel));
