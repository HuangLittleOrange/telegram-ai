import type { ApiUpdate, OnApiUpdate } from '../../types';

import { API_THROTTLE_RESET_UPDATES, API_UPDATE_THROTTLE } from '../../../config';
import { throttle, throttleWithTickEnd } from '../../../util/schedulers';

let onUpdate: OnApiUpdate | undefined;

export function init(_onUpdate: OnApiUpdate) {
  onUpdate = _onUpdate;

  if (pendingUpdates?.length && currentThrottleId !== undefined) {
    flushUpdates(currentThrottleId);
  }
}

export function sendApiUpdate(update: ApiUpdate) {
  queueUpdate(update);
}

export function sendImmediateApiUpdate(update: ApiUpdate) {
  if (onUpdate) {
    onUpdate(update);
    return;
  }

  queueUpdate(update);
}

const flushUpdatesOnTickEnd = throttleWithTickEnd(flushUpdates);

let flushUpdatesThrottled: typeof flushUpdatesOnTickEnd | undefined;
let currentThrottleId: number | undefined;

let pendingUpdates: ApiUpdate[] | undefined;

function queueUpdate(update: ApiUpdate) {
  if (!pendingUpdates) {
    pendingUpdates = [update];
  } else {
    pendingUpdates.push(update);
  }

  if (!flushUpdatesThrottled || API_THROTTLE_RESET_UPDATES.has(update['@type'])) {
    flushUpdatesThrottled = throttle(flushUpdatesOnTickEnd, API_UPDATE_THROTTLE, true);
    currentThrottleId = Math.random();
  }

  flushUpdatesThrottled(currentThrottleId!);
}

function flushUpdates(throttleId: number) {
  if (!pendingUpdates || throttleId !== currentThrottleId) {
    return;
  }

  if (!onUpdate) {
    return;
  }

  const currentUpdates = pendingUpdates;
  pendingUpdates = undefined;
  currentUpdates.forEach(onUpdate);
}
