import type { ApiMessage } from '../../api/types';
import type { GlobalState } from '../types';

import { persistSyncedMessagesForChat } from './syncedMessagesStore';

export function shouldPersistRealtimeMessage(message: ApiMessage, isLocal: boolean) {
  return !isLocal && !message.isScheduled;
}

export function persistRealtimeMessageToSyncedStore(args: {
  global: GlobalState;
  chatId: string;
  message: ApiMessage;
  isLocal: boolean;
}) {
  const {
    global,
    chatId,
    message,
    isLocal,
  } = args;

  if (!shouldPersistRealtimeMessage(message, isLocal)) {
    return;
  }

  void persistSyncedMessagesForChat(global, chatId, [message]).catch(() => undefined);
}
