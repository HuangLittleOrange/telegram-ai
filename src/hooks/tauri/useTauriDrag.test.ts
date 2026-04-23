/* eslint-disable react-x/no-unnecessary-use-prefix */

jest.mock('../../lib/teact/teact', () => ({
  useCallback: <T extends (...args: any[]) => unknown>(callback: T) => callback,
  useEffect: (effect: () => VoidFunction | undefined) => effect(),
}));

jest.mock('../../util/browser/globalEnvironment', () => ({
  IS_TAURI: true,
}));

jest.mock('../../util/browser/windowEnvironment', () => ({
  IS_MAC_OS: true,
}));

import useTauriDrag from './useTauriDrag';

describe('useTauriDrag', () => {
  it('starts dragging synchronously from the mousedown handler', () => {
    const startDragging = jest.fn();

    window.tauri = {
      getCurrentWindow: jest.fn(() => ({ startDragging })),
    } as any;

    const dragRegion = document.createElement('div');
    dragRegion.dataset.tauriDragRegion = 'true';
    document.body.append(dragRegion);

    useTauriDrag();

    dragRegion.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(startDragging).toHaveBeenCalledTimes(1);
  });
});
