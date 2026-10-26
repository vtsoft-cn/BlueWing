import React, { useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Portal } from './Portal';

/**
 * 问号悬停提示:仅悬停图标本身触发(不随所在按钮整体 hover)。
 * Portal 到 body + fixed 定位并按视口钳位——不依赖父容器的 overflow,
 * 弹窗内右侧图标也不会被弹窗边界裁剪。
 */
export const InfoTip: React.FC<{ text: string }> = ({ text }) => {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const iconRef = useRef<HTMLSpanElement>(null);

  const show = (): void => {
    const r = iconRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 224; // w-56
    let x = r.left + r.width / 2 - W / 2;
    x = Math.min(Math.max(8, x), window.innerWidth - W - 8);
    setPos({ x, y: r.bottom + 6 });
  };

  return (
    <span
      ref={iconRef}
      className="relative inline-flex items-center"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      <HelpCircle className="w-3 h-3 text-slate-400 hover:text-blue-500" />
      {pos && (
        <Portal>
          <div
            className="fixed z-[300] w-56 rounded-lg bg-slate-800 dark:bg-slate-700 text-white text-[10px] leading-relaxed font-normal text-left px-2.5 py-2 shadow-xl"
            style={{ left: pos.x, top: pos.y }}
          >
            {text}
          </div>
        </Portal>
      )}
    </span>
  );
};
