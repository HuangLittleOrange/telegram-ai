import type { ElementRef } from '../lib/teact/teact';
import { useEffect, useLayoutEffect, useState } from '../lib/teact/teact';

import { requestMutation } from '../lib/fasterdom/fasterdom';
import useFlag from './useFlag';
import useLastCallback from './useLastCallback';

type ResizeOptions = {
  direction?: 1 | -1;
  minWidth?: number;
  maxWidth?: number;
  cssPropertyTarget?: 'self' | 'root' | ElementRef<HTMLElement>;
};

export function useResize(
  elementRef: ElementRef<HTMLElement>,
  onResize: (width: number) => void,
  onReset: NoneToVoidFunction,
  initialWidth?: number,
  cssPropertyName?: string,
  options?: ResizeOptions,
) {
  const [isActive, markIsActive, unmarkIsActive] = useFlag();
  const [initialMouseX, setInitialMouseX] = useState<number>(0);
  const [initialElementWidth, setInitialElementWidth] = useState<number>(0);

  const getCssPropertyTarget = useLastCallback(() => {
    if (!options?.cssPropertyTarget || options.cssPropertyTarget === 'self') {
      return elementRef.current;
    }

    if (options.cssPropertyTarget === 'root') {
      return document.documentElement;
    }

    return options.cssPropertyTarget.current;
  });

  const setElementStyle = useLastCallback((width?: number) => {
    requestMutation(() => {
      if (!elementRef.current) {
        return;
      }

      const widthPx = width ? `${width}px` : '';
      elementRef.current.style.width = widthPx;
      if (cssPropertyName) {
        const cssPropertyTarget = getCssPropertyTarget();
        if (cssPropertyTarget) {
          cssPropertyTarget.style.setProperty(cssPropertyName, widthPx);
        }
      }
    });
  });

  useLayoutEffect(() => {
    if (!elementRef.current || !initialWidth) {
      return;
    }

    setElementStyle(initialWidth);
  }, [cssPropertyName, elementRef, initialWidth, setElementStyle]);

  function handleMouseUp() {
    requestMutation(() => {
      document.body.classList.remove('cursor-ew-resize');
    });
  }

  function initResize(e: React.MouseEvent<HTMLElement, MouseEvent>) {
    e.preventDefault();

    requestMutation(() => {
      document.body.classList.add('cursor-ew-resize');
    });

    setInitialMouseX(e.clientX);
    setInitialElementWidth(elementRef.current!.offsetWidth);
    markIsActive();
  }

  function resetResize(e: React.MouseEvent<HTMLElement, MouseEvent>) {
    e.preventDefault();
    setElementStyle(undefined);
    onReset();
  }

  useEffect(() => {
    if (!isActive) return undefined;

    const handleMouseMove = (e: MouseEvent) => {
      const direction = options?.direction ?? 1;
      const rawWidth = Math.ceil(initialElementWidth + ((e.clientX - initialMouseX) * direction));
      const minWidth = options?.minWidth ?? Number.MIN_SAFE_INTEGER;
      const maxWidth = options?.maxWidth ?? Number.MAX_SAFE_INTEGER;
      const newWidth = Math.max(minWidth, Math.min(maxWidth, rawWidth));
      setElementStyle(newWidth);
    };

    function stopDrag() {
      cleanup();
      onResize(elementRef.current!.offsetWidth);
    }

    function cleanup() {
      handleMouseUp();
      document.removeEventListener('mousemove', handleMouseMove, false);
      document.removeEventListener('mouseup', stopDrag, false);
      document.removeEventListener('blur', stopDrag, false);
      unmarkIsActive();
    }

    document.addEventListener('mousemove', handleMouseMove, false);
    document.addEventListener('mouseup', stopDrag, false);
    document.addEventListener('blur', stopDrag, false);

    return cleanup;
  }, [initialElementWidth, initialMouseX, elementRef, onResize, isActive, unmarkIsActive, setElementStyle, options]);

  return { initResize, resetResize, handleMouseUp };
}
