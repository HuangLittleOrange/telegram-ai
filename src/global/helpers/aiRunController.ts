type ActiveRun = {
  runId: string;
  abortController: AbortController;
  streamStatus: 'streaming' | 'cancelling';
};

type CancelledSnapshot = {
  runId: string;
  streamStatus: 'cancelled';
};

function createRunId(tabId: number) {
  return `ai-${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAiRunController() {
  const runsByTab = new Map<number, ActiveRun>();

  const startRun = (tabId: number) => {
    const current = runsByTab.get(tabId);
    if (current) {
      current.streamStatus = 'cancelling';
      current.abortController.abort('Superseded by a newer AI run');
      runsByTab.delete(tabId);
    }

    const next: ActiveRun = {
      runId: createRunId(tabId),
      abortController: new AbortController(),
      streamStatus: 'streaming',
    };
    runsByTab.set(tabId, next);
    return next;
  };

  const getActiveRun = (tabId: number) => runsByTab.get(tabId);

  const isActiveRun = (tabId: number, runId: string) => runsByTab.get(tabId)?.runId === runId;

  const finishRun = (tabId: number, runId: string) => {
    const current = runsByTab.get(tabId);
    if (current?.runId === runId) {
      runsByTab.delete(tabId);
    }
  };

  const cancelRun = (tabId: number): CancelledSnapshot | undefined => {
    const current = runsByTab.get(tabId);
    if (!current) {
      return undefined;
    }

    current.streamStatus = 'cancelling';
    current.abortController.abort('Cancelled by user');
    runsByTab.delete(tabId);

    return {
      runId: current.runId,
      streamStatus: 'cancelled',
    };
  };

  return {
    startRun,
    getActiveRun,
    isActiveRun,
    finishRun,
    cancelRun,
  };
}

const aiRunController = createAiRunController();

export default aiRunController;
