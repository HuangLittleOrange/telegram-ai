import type { TimeRange } from '../types/tabState';

import {
  calculateUnsyncedMessages,
  countMessagesInRange,
  getOldestMessageDateInRange,
  resolveTimeRangeBoundsSec,
} from './chatSync';

describe('chatSync helpers', () => {
  describe('resolveTimeRangeBoundsSec', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-09T12:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('resolves a preset range to second bounds', () => {
      const range: TimeRange = {
        mode: 'preset',
        value: 'today',
      };

      const bounds = resolveTimeRangeBoundsSec(range);
      const now = new Date('2026-04-09T12:00:00.000Z');
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const nextDay = new Date(startOfDay);
      nextDay.setDate(nextDay.getDate() + 1);

      expect(bounds!.startSec).toBe(Math.floor(startOfDay.getTime() / 1000));
      expect(bounds!.endSec).toBe(Math.floor(nextDay.getTime() / 1000));
    });

    it('resolves a custom range to second bounds', () => {
      const range: TimeRange = {
        mode: 'custom',
        startAt: 1770000000000,
        endAt: 1770012345678,
      };

      const bounds = resolveTimeRangeBoundsSec(range);

      expect(bounds!.startSec).toBe(1770000000);
      expect(bounds!.endSec).toBe(1770012346);
    });
  });

  describe('countMessagesInRange', () => {
    it('counts only messages within the selected range', () => {
      const bounds = {
        startSec: 100,
        endSec: 200,
      };

      const messagesById = {
        1: { id: 1, date: 50 },
        2: { id: 2, date: 100 },
        3: { id: 3, date: 150 },
        4: { id: 4, date: 199 },
        5: { id: 5, date: 200 },
      } as any;

      expect(countMessagesInRange(messagesById, bounds)).toBe(3);
    });

    it('returns 0 when no range or messages are provided', () => {
      expect(countMessagesInRange(undefined, undefined)).toBe(0);
      expect(countMessagesInRange({}, undefined)).toBe(0);
    });
  });

  describe('getOldestMessageDateInRange', () => {
    it('returns the oldest message date within range', () => {
      const bounds = { startSec: 10, endSec: 30 };
      const messagesById = {
        1: { id: 1, date: 5 },
        2: { id: 2, date: 10 },
        3: { id: 3, date: 29 },
        4: { id: 4, date: 40 },
      } as any;

      expect(getOldestMessageDateInRange(messagesById, bounds)).toBe(10);
    });
  });

  describe('calculateUnsyncedMessages', () => {
    it('never returns negative unsynced values', () => {
      expect(calculateUnsyncedMessages(100, 30)).toBe(70);
      expect(calculateUnsyncedMessages(100, 150)).toBe(0);
    });
  });
});
