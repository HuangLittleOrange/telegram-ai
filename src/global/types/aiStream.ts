export type AiStreamStage = 'retriever' | 'answer' | 'summary';

export type AiStreamEvent =
  | {
    type: 'run.started';
    runId: string;
    createdAt: number;
  }
  | {
    type: 'thinking.stage';
    runId: string;
    stage: AiStreamStage;
    title: string;
    detail?: string;
    createdAt: number;
  }
  | {
    type: 'thinking.trace';
    runId: string;
    stage: AiStreamStage;
    title: string;
    detail?: string;
    createdAt: number;
  }
  | {
    type: 'retriever.query';
    runId: string;
    title: string;
    detail?: string;
    createdAt: number;
  }
  | {
    type: 'retriever.result';
    runId: string;
    title: string;
    detail?: string;
    createdAt: number;
  }
  | {
    type: 'tool.output';
    runId: string;
    toolType: string;
    description?: string;
    payload: unknown;
    createdAt: number;
  }
  | {
    type: 'answer.delta';
    runId: string;
    textDelta: string;
    createdAt: number;
  }
  | {
    type: 'answer.final';
    runId: string;
    text: string;
    createdAt: number;
  }
  | {
    type: 'run.done';
    runId: string;
    createdAt: number;
  }
  | {
    type: 'run.error';
    runId: string;
    error: string;
    createdAt: number;
  }
  | {
    type: 'run.cancelled';
    runId: string;
    createdAt: number;
  };
