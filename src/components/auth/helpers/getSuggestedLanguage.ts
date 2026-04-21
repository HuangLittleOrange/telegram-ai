import type { LangCode } from '../../../types';

export function getSuggestedLanguage() {
  const normalizedLanguage = navigator.language.toLowerCase();

  if (normalizedLanguage.startsWith('zh')) {
    if (
      normalizedLanguage.includes('hant')
      || normalizedLanguage.includes('-tw')
      || normalizedLanguage.includes('-hk')
    ) {
      return 'zh-hant' as LangCode;
    }

    return 'zh-hans' as LangCode;
  }

  if (normalizedLanguage === 'pt-br') {
    return normalizedLanguage as LangCode;
  }

  return normalizedLanguage.slice(0, 2) as LangCode;
}
