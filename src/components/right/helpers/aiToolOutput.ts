import type { ToolOutput } from '../../../global/types/tabState';

export type AiToolOutputSummary = {
  title: string;
  detail?: string;
};

export function formatAiToolOutputSummary(toolOutput: ToolOutput): AiToolOutputSummary {
  if (
    toolOutput.type === 'message.fetch'
    && 'query' in toolOutput
    && 'result' in toolOutput
  ) {
    const mode = toolOutput.query.mode === 'person'
      ? '按人查看'
      : toolOutput.query.mode === 'keyword'
        ? '按关键词查看'
        : toolOutput.query.mode === 'range'
          ? '按时间查看'
          : '最近消息';
    const detail = [
      `命中 ${toolOutput.result.total} 条`,
      toolOutput.result.truncated ? '结果已截断' : '结果完整',
    ].join(' · ');

    return {
      title: mode,
      detail,
    };
  }

  if ('description' in toolOutput && toolOutput.description?.trim()) {
    return {
      title: toolOutput.description.trim(),
      detail: '工具已完成',
    };
  }

  return {
    title: toolOutput.type,
    detail: '工具已完成',
  };
}
