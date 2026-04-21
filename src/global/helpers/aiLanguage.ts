export type AiPromptLocale = 'zh' | 'en';

export function resolveAiPromptLocale(languageCode?: string): AiPromptLocale {
  const normalizedCode = languageCode?.trim().toLowerCase();

  if (!normalizedCode) {
    return 'zh';
  }

  if (normalizedCode.startsWith('zh')) {
    return 'zh';
  }

  if (normalizedCode.startsWith('en')) {
    return 'en';
  }

  return 'en';
}

export function isChinesePromptLocale(languageCode?: string) {
  return resolveAiPromptLocale(languageCode) === 'zh';
}
