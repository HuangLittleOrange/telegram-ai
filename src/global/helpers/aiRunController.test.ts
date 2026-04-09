import { createAiRunController } from './aiRunController';

describe('aiRunController', () => {
  it('cancels the active run and clears registry entry', () => {
    const controller = createAiRunController();
    const started = controller.startRun(1);

    expect(controller.getActiveRun(1)?.runId).toBe(started.runId);
    expect(controller.isActiveRun(1, started.runId)).toBe(true);

    const cancelled = controller.cancelRun(1);

    expect(cancelled?.runId).toBe(started.runId);
    expect(cancelled?.streamStatus).toBe('cancelled');
    expect(controller.getActiveRun(1)).toBeUndefined();
    expect(controller.isActiveRun(1, started.runId)).toBe(false);
  });

  it('replaces previous run on startRun and keeps only latest active run', () => {
    const controller = createAiRunController();
    const first = controller.startRun(1);
    const second = controller.startRun(1);

    expect(first.runId).not.toBe(second.runId);
    expect(controller.isActiveRun(1, first.runId)).toBe(false);
    expect(controller.isActiveRun(1, second.runId)).toBe(true);

    controller.finishRun(1, first.runId);
    expect(controller.isActiveRun(1, second.runId)).toBe(true);

    controller.finishRun(1, second.runId);
    expect(controller.getActiveRun(1)).toBeUndefined();
  });
});
