import React from 'react';
import { Minus, X } from 'lucide-react';

interface PageHeaderProps {
  coreState: string;
  activeNodeName?: string;
  latency?: number;
}

/** 页头:左侧连接状态(原侧边栏底部状态卡),右侧窗口最小化/关闭;空白区域可拖动窗口(全局规则) */
export const PageHeader: React.FC<PageHeaderProps> = ({ coreState, activeNodeName, latency }) => {
  const isConnected = coreState === 'running';

  return (
    <header className="drag-region h-9 w-full flex items-center justify-between pl-3 pr-1.5 border-b border-slate-200/80 dark:border-slate-800/80 bg-white/85 dark:bg-slate-900/85 select-none z-50 flex-shrink-0">
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
