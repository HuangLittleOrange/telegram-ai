import { memo, useEffect, useMemo } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiChat } from '../../api/types';
import type { ChatSyncState } from '../../global/types';
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

const ChatSyncPanel = ({
  chatId,
  threadId,
  chat,
  syncState,
}: OwnProps & StateProps) => {
  const {
    loadChatSyncStats,
    setChatSyncMethod,
    startChatSync,
    pauseChatSync,
    resetChatSync,
  } = getActions();

  const isSupportedChat = Boolean(chat && (isChatGroup(chat) || isChatChannel(chat)));
  const resolvedThreadId = threadId || MAIN_THREAD_ID;

  useEffect(() => {
    if (!isSupportedChat) return;
    loadChatSyncStats({ chatId, threadId: resolvedThreadId });
  }, [chatId, isSupportedChat, loadChatSyncStats, resolvedThreadId]);

  const isRangeScopedSync = syncState.selectedTimeRange?.mode === 'custom';
  const hasReliableScopedTotal = syncState.scopedTotalMessages !== undefined;
  const isSyncBusy = syncState.status === 'syncing' || syncState.status === 'clearing';

  const progress = useMemo(() => {
    const progressBaseTotal = isRangeScopedSync ? syncState.scopedTotalMessages : syncState.totalMessages;
    if (!progressBaseTotal) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round((syncState.syncedMessages / progressBaseTotal) * 100)));
  }, [isRangeScopedSync, syncState.scopedTotalMessages, syncState.syncedMessages, syncState.totalMessages]);

  const statusText = useMemo(() => {
    switch (syncState.status) {
      case 'syncing':
        return '同步中';
      case 'paused':
        return '已暂停';
      case 'clearing':
        return '清空中';
      case 'completed':
        return '已完成';
      case 'error':
        return '同步失败';
      case 'idle':
      default:
        return '待同步';
    }
  }, [syncState.status]);

  const syncedRangeStartTimestamp = syncState.oldestSyncedDate;
  const syncedRangeStartText = formatDateOnly(syncedRangeStartTimestamp);
  const syncedRangeEndText = formatDateOnly(syncState.newestSyncedDate);
  const syncErrorDetail = summarizeSyncErrorDetail(syncState.errorDetail);
  const syncErrorCode = resolveDisplayedSyncErrorCode(syncState.errorCode, syncState.errorDetail);

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
            disabled={isSyncBusy}
          />
          Data Export（推荐）
        </label>
        <label className="method-option">
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
        <div className="warning">
          高频率拉取可能触发 Telegram 反滥用限制，请谨慎使用。
        </div>
      )}

      <div className="metrics">
        <span>
          总量：
          {syncState.totalMessages || 0}
        </span>
        <span>
          已同步：
          {syncState.syncedMessages}
        </span>
      </div>

      {(!isRangeScopedSync || hasReliableScopedTotal) && (
        <div className="progress-track">
          <div className="progress-fill" style={`width: ${progress}%`} />
        </div>
      )}

      <div className="oldest">
        已同步时间：
        {syncedRangeStartText}
        {' '}
        至
        {' '}
        {syncedRangeEndText}
      </div>

      {syncState.error && (
        <div className="error">
          <div>{syncState.error}</div>
          {syncErrorCode && (
            <div className="error-code">
              错误码：
              {' '}
              {syncErrorCode}
            </div>
          )}
          {syncErrorDetail && (
            <div className="error-detail">
              详情：
              {' '}
              {syncErrorDetail}
            </div>
          )}
        </div>
      )}

      <div className="actions">
        <div className="primary-slot">
          {syncState.status === 'syncing' ? (
            <Button
              className="primary-action"
              size="tiny"
              color="translucent"
              onClick={() => pauseChatSync({ chatId, threadId: resolvedThreadId })}
            >
              暂停同步
            </Button>
          ) : (
            <Button
              className="primary-action"
              size="tiny"
              color="primary"
              disabled={syncState.status === 'clearing'}
              onClick={() => startChatSync({ chatId, threadId: resolvedThreadId })}
            >
              {syncState.status === 'paused'
                ? '继续同步'
                : syncState.status === 'clearing'
                  ? '清空中...'
                  : '开始同步'}
            </Button>
          )}
        </div>
        <Button
          className="secondary-action"
          size="tiny"
          color="translucent"
          onClick={() => {
            resetChatSync({ chatId, threadId: resolvedThreadId });
            startChatSync({ chatId, threadId: resolvedThreadId });
          }}
          disabled={isSyncBusy}
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
