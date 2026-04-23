describe('initial global state', () => {
  beforeEach(() => {
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    });
    globalThis.CSS = {
      supports: jest.fn(() => false),
    } as unknown as typeof CSS;
  });

  it('starts AI settings without a default model or base URL', async () => {
    const { INITIAL_GLOBAL_STATE } = await import('./initialState');

    expect(INITIAL_GLOBAL_STATE.settings.byKey.aiSettings.model).toBe('');
    expect(INITIAL_GLOBAL_STATE.settings.byKey.aiSettings.baseUrl).toBeUndefined();
  });
});
