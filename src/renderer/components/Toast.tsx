import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warn' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

type Listener = (item: ToastItem) => void;
const listeners = new Set<Listener>();
let seq = 0;

function push(type: ToastType, message: string): void {
  const item = { id: ++seq, type, message };
  listeners.forEach((l) => l(item));
}

/** 轻提示:toast.success('已保存') / toast.error('失败原因') 等,替代原生 alert */
export const toast = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
  warn: (message: string) => push('warn', message),
  info: (message: string) => push('info', message),
};

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-500" />,
  error: <XCircle className="w-5 h-5 shrink-0 text-red-500" />,
  warn: <AlertTriangle className="w-5 h-5 shrink-0 text-amber-500" />,
  info: <Info className="w-5 h-5 shrink-0 text-blue-500" />,
};

const ACCENTS: Record<ToastType, string> = {
  success: 'border-l-emerald-500',
  error: 'border-l-red-500',
  warn: 'border-l-amber-500',
  info: 'border-l-blue-500',
};

const DURATION: Record<ToastType, number> = {
  success: 3600,
  error: 6500,
  warn: 5000,
  info: 3600,
};

const ToastCard: React.FC<{ item: ToastItem; onClose: () => void }> = ({ item, onClose }) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    const timer = setTimeout(onClose, DURATION[item.type]);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onClick={onClose}
      className={`cursor-pointer w-80 rounded-xl border border-slate-200 dark:border-slate-700/70 border-l-4 ${ACCENTS[item.type]} bg-white dark:bg-slate-900 shadow-lg shadow-slate-900/10 dark:shadow-black/30 p-3 flex items-start gap-2.5 transition-all duration-200 ease-out ${
        shown ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-5'
      }`}
    >
      {ICONS[item.type]}
      <div className="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-200 leading-relaxed break-words whitespace-pre-line pt-0.5">
        {item.message}
      </div>
      <button
        onClick={onClose}
        className="shrink-0 -m-1.5 p-1.5 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

/** 全局提示宿主:在 App 根部挂载一次即可,配合 toast.xxx() 使用 */
export const ToastHost: React.FC = () => {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener: Listener = (item) => {
      setItems((prev) => [...prev.slice(-4), item]);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const remove = (id: number) => setItems((prev) => prev.filter((t) => t.id !== id));

  return (
    /* no-drag:body 全局是 app-region 拖拽面,而滚动后区域缓存错位且不重发(electron#40610),
       后挂载的卡片若落在拖拽面内,关闭按钮的点击会被原生拖拽层吞掉;容器常驻、
       启动即注册为非拖拽区,卡片再挂载无需区域更新 */
    <div className="no-drag fixed top-14 right-4 z-[220] flex flex-col gap-2 pointer-events-none">
      {items.map((item) => (
        <div key={item.id} className="pointer-events-auto">
          <ToastCard item={item} onClose={() => remove(item.id)} />
        </div>
      ))}
    </div>
  );
};
