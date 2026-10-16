import React, { useRef } from 'react';
import { Minus, X } from 'lucide-react';

interface PageHeaderProps {
  coreState: string;
  activeNodeName?: string;
  latency?: number;
}

/** 页头:左侧连接状态(原侧边栏底部状态卡),右侧窗口最小化/关闭。
 *  拖动窗口:Chromium 缺陷使 app-region 在内容区滚动后失效(electron#40610),
 *  故页头为 no-drag + pointer 事件走主进程 IPC 拖动,滚动后依然可靠。 */
export const PageHeader: React.FC<PageHeaderProps> = ({ coreState, activeNodeName, latency }) => {
  const isConnected = coreState === 'running';
  // 发起拖动的指针 id:多指场景下只有发起那只抬起才结束拖动;null 表示未在拖动
  const dragPointerRef = useRef<number | null>(null);

  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (dragPointerRef.current !== null && e.pointerId !== dragPointerRef.current) return;
    dragPointerRef.current = null;
    window.electronAPI?.window.endDrag();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // 窗口控制按钮不触发拖动
    if ((e.target as HTMLElement).closest('button, input, select, a')) return;
    if (dragPointerRef.current !== null) return;
    // 捕获指针:光标移出窗口也能收到 pointerup,保证拖动一定结束;
    // 捕获失败(指针已释放等极端情形)则不启动拖动,避免移动循环收不到结束信号
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      return;
    }
    dragPointerRef.current = e.pointerId;
    window.electronAPI?.window.beginDrag();
  };

  return (
    <header
      onPointerDown={handlePointerDown}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      className="no-drag h-9 w-full flex items-center justify-between pl-3 pr-1.5 border-b border-slate-200/80 dark:border-slate-800/80 bg-white/85 dark:bg-slate-900/85 select-none z-50 flex-shrink-0"
    >
      {/* 连接状态 */}
      <div className="flex items-center gap-2 text-xs min-w-0">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            isConnected
              ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50'
              : 'bg-slate-400 dark:bg-slate-600'
          }`}
        />
        <span className="font-medium text-slate-700 dark:text-slate-300 flex-shrink-0">
          {isConnected ? '已连接' : '已断开'}
        </span>
        <span className="text-slate-500 dark:text-slate-400 truncate">
          {activeNodeName || '未选择节点'}
        </span>
        {isConnected && latency !== undefined && latency > 0 && (
          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold px-1.5 py-0.5 rounded bg-emerald-500/10 flex-shrink-0 font-mono">
            {latency} ms
          </span>
        )}
      </div>

      {/* 窗口控制 */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          onClick={() => window.electronAPI?.window.minimize()}
          title="最小化"
          className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => window.electronAPI?.window.close()}
          title="关闭"
          className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-red-500 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
