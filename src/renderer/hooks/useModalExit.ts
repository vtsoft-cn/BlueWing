import { useCallback, useRef, useState } from 'react';

/**
 * 弹窗关闭动画:调用 requestClose() 后先给蒙版/面板挂收场类
 * (overlay-exit / pop-exit,见 index.css),动画结束(200ms)才真正执行 onClose。
 * 蒙版点击关闭、取消按钮、Esc 等路径统一走 requestClose 即可获得收场动画。
 * 动画期间二次触发会被忽略,不会重复执行 onClose。
 */
export function useModalExit(onClose: () => void, durationMs = 200): {
  exiting: boolean;
  requestClose: () => void;
} {
  const [exiting, setExiting] = useState(false);
  const closingRef = useRef(false);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setExiting(true);
    setTimeout(onClose, durationMs);
  }, [onClose, durationMs]);

  return { exiting, requestClose };
}
