import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  /** 置灰不可选(如网关暂不支持该认证方式) */
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 传给触发按钮的额外类名(沿用各页面原 select 的样式即可) */
  className?: string;
  placeholder?: string;
  /** 触发按钮的无障碍名(替代原生 select 的 aria-label) */
  ariaLabel?: string;
}

interface PanelState {
  rect: DOMRect;
}

/**
 * 自定义下拉选择:替代原生 <select>(原生下拉面板由系统渲染,无法定制样式)。
 * 面板通过 Portal 挂到 body,按触发按钮矩形绝对定位,不会被弹窗/滚动容器裁剪。
 */
export const Select: React.FC<SelectProps> = ({ value, options, onChange, className = '', placeholder, ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const current = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (open && btnRef.current) {
      setPanel({ rect: btnRef.current.getBoundingClientRect() });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const r = panel?.rect;
  const panelStyle: React.CSSProperties = r
    ? {
        position: 'fixed',
        left: r.left,
        top: r.bottom + 4,
        width: Math.min(Math.max(r.width, 180), 420),
        maxHeight: Math.min(232, window.innerHeight - r.bottom - 12),
      }
    : { display: 'none' };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 text-left focus:outline-none focus:border-blue-500 transition-colors ${className}`}
      >
        <span className={`text-xs truncate ${current ? '' : 'text-slate-400'}`}>
          {current?.label || placeholder || value}
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="no-drag fixed z-[240] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl shadow-slate-900/10 dark:shadow-black/40 py-1 overflow-y-auto"
          >
            {options.map((o, i) => (
              <button
                key={`${o.value}-${i}`}
                type="button"
                disabled={o.disabled}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 transition-colors ${
                  o.disabled
                    ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-600'
                    : o.value === value
                      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <span className="truncate">{o.label}</span>
                {o.value === value && <Check className="w-3.5 h-3.5 shrink-0" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
};
