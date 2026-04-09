import type { ApiUpdate } from '../../types';

describe('apiUpdateEmitter', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not crash when updates arrive before init and flushes them after init', async () => {
    const { init, sendApiUpdate } = await import('./apiUpdateEmitter');

    const received: ApiUpdate[] = [];
    const update = { '@type': 'updateApiReady' } as ApiUpdate;

    sendApiUpdate(update);

    await Promise.resolve();
    jest.runOnlyPendingTimers();

    expect(received).toEqual([]);

    init((nextUpdate) => {
      received.push(nextUpdate);
    });

    expect(received).toEqual([update]);
  });
});
