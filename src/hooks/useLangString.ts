import { useEffect, useState } from '../lib/teact/teact';

import type { RegularLangKey } from '../types/language';

import { callApi } from '../api/gramjs';
import useLastCallback from './useLastCallback';

export default function useLangString(key: RegularLangKey, langCode?: string) {
  const [value, setValue] = useState<string | undefined>(undefined);

  const fetchLangString = useLastCallback(async () => {
    if (!langCode) return undefined;

    const result = await callApi('fetchLangStringsBestEffort', {
      langCode,
      keys: [key],
    });
    const langString = result?.strings[key];
    if (!langString || typeof langString !== 'string') return undefined;
    return langString;
  });

  useEffect(() => {
    fetchLangString().then(setValue);
  }, [key, langCode]);

  return value;
}
