export function sanitizeAssistantText(text: string | undefined) {
  if (!text) return undefined;

  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/&lt;think\b[^&]*&gt;[\s\S]*?&lt;\/think&gt;/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/&lt;think\b[^&]*&gt;[\s\S]*$/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
