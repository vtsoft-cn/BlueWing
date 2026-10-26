import React, { useEffect, useState } from 'react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作(删除/恢复出厂/覆盖还原)时确认按钮为红色 */
  danger?: boolean;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;
let askFn: Ask | null = null;

/** 自定义确认对话框:替代原生 confirm,用法 const ok = await confirmDialog({ message, danger: true }) */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (!askFn) return Promise.resolve(false);
  return askFn(options);
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (v: boolean) => void;
}

/** 全局确认宿主:在 App 根部挂载一次即可 */
export const ConfirmDialogHost: React.FC = () => {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // 收场动画:resolve 立即放行调用方,蒙版/面板播完 overlay-exit/pop-exit 再卸载
  const [exiting, setExiting] = useState(false);
  const closingRef = React.useRef(false);

  useEffect(() => {
    askFn = (options) =>
      new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      });
    return () => {
      askFn = null;
    };
  }, []);

  if (!pending) return null;
  const { options, resolve } = pending;
  const close = (v: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setExiting(true);
    resolve(v);
    setTimeout(() => setPending(null), 200);
  };

  return (
    <div
      className={`no-drag fixed inset-0 z-[210] bg-black/60 flex items-center justify-center p-4 ${
        exiting ? 'overlay-exit' : 'overlay-enter'
      }`}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.target !== e.currentTarget) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}
        window.electronAPI?.window.beginDrag();
      }}
      onPointerUp={() => window.electronAPI?.window.endDrag()}
      onPointerCancel={() => window.electronAPI?.window.endDrag()}
      onLostPointerCapture={() => window.electronAPI?.window.endDrag()}
    >
      <div
        className={`bg-white dark:bg-slate-900 rounded-2xl max-w-sm w-full p-5 border border-slate-200 dark:border-slate-800 shadow-2xl ${
          exiting ? 'pop-exit' : 'pop-enter'
        }`}
      >
        {options.title && (
          <h4 className="font-semibold text-sm text-slate-900 dark:text-slate-100 mb-1.5">{options.title}</h4>
        )}
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed break-words whitespace-pre-line">
          {options.message}
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          >
            {options.cancelText || '取消'}
          </button>
          <button
            onClick={() => close(true)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors ${
              options.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400'
            }`}
          >
            {options.confirmText || '确定'}
          </button>
        </div>
      </div>
    </div>
  );
};
