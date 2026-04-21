import { getSuggestedLanguage } from './getSuggestedLanguage';

describe('getSuggestedLanguage', () => {
  const originalLanguage = navigator.language;

  afterEach(() => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: originalLanguage,
    });
  });

  it('maps simplified Chinese locales to zh-hans', () => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'zh-CN',
    });

    expect(getSuggestedLanguage()).toBe('zh-hans');
  });

  it('maps traditional Chinese locales to zh-hant', () => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'zh-TW',
    });

    expect(getSuggestedLanguage()).toBe('zh-hant');
  });

  it('keeps pt-br and shortens other locales', () => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'pt-BR',
    });
    expect(getSuggestedLanguage()).toBe('pt-br');

    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'fr-FR',
    });
    expect(getSuggestedLanguage()).toBe('fr');
  });
});
