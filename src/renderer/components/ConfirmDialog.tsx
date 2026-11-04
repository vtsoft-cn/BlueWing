import React, { useEffect, useId, useState } from 'react';
import { modalOverlayClass, modalPopClass, useMaskDrag } from './ModalShell';

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
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  const maskDrag = useMaskDrag();

  useEffect(() => {
    askFn = (options) =>
      new Promise<boolean>((resolve) => {
        // Host 常驻不卸载,closingRef 在上一次收场后残留 true;新弹窗即新生命周期,必须复位,
        // 否则第二次起所有按钮点击都被 close() 的关闭锁吞掉(确认框永久死锁)
        closingRef.current = false;
        setExiting(false);
        setPending({ options, resolve });
      });
    return () => {
      askFn = null;
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, [pending]);

  if (!pending) return null;
  const { options, resolve } = pending;
  const close = (v: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setExiting(true);
    resolve(v);
    // 收场动画期内若又开了新弹窗,不得把新 pending 清掉(只清自己这次的状态)
    const mine = pending;
    setTimeout(() => setPending((curr) => (curr === mine ? null : curr)), 200);
  };

  return (
    <div
      {...maskDrag}
      className={`no-drag fixed inset-0 z-[210] bg-black/60 flex items-center justify-center p-4 ${modalOverlayClass(exiting)}`}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={options.title ? titleId : undefined}
        aria-label={options.title ? undefined : '确认操作'}
        aria-describedby={messageId}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(false);
          }
          if (event.key === 'Tab') {
            const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button');
            const first = buttons?.[0], last = buttons?.[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
        className={`bg-white dark:bg-slate-900 rounded-2xl max-w-sm w-full max-h-[calc(100dvh-2rem)] flex flex-col p-5 border border-slate-200 dark:border-slate-800 shadow-2xl ${modalPopClass(exiting)}`}
      >
        {options.title && (
          <h4 id={titleId} className="font-semibold text-sm text-slate-900 dark:text-slate-100 mb-1.5">{options.title}</h4>
        )}
        <p id={messageId} className="min-h-0 overflow-y-auto text-xs text-slate-500 dark:text-slate-400 leading-relaxed break-words whitespace-pre-line">
          {options.message}
        </p>
        <div className="flex shrink-0 justify-end gap-2 mt-4">
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
