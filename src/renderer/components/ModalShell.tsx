import React from 'react';
import { useModalExit } from '../hooks/useModalExit';
import { createContext, useContext } from 'react';

/** 弹窗内组件经此拿到"带收场动画的关闭函数";由 ModalShell 提供 */
const ModalCloseContext = createContext<() => void>(() => {});
/** 获取当前弹窗的收场关闭函数(取消按钮/X 均应使用它而非直接调用 onClose prop) */
export const useModalClose = () => useContext(ModalCloseContext);

interface ModalShellProps {
  onClose: () => void;
  children: React.ReactNode;
  /** 透传到蒙版的额外类(vpn-modal-backdrop 等定制皮肤) */
  overlayClassName?: string;
  /** 点击蒙版空白处是否关闭(默认 true) */
  closeOnBackdrop?: boolean;
  /** 确认框等需要在拖动后忽略点击关闭的场景:拖动观察器由外部处理时置 false */
  z?: number;
}

/**
 * 弹窗壳:统一入场(overlay-enter/pop-enter)与收场(经 useModalExit 挂
 * overlay-exit/pop-exit 后延时卸载)动画,并内置蒙版拖动窗口(与页头同一 IPC 机制)。
 * 面板请给直接子元素加 pop-enter(收场时由本壳切换为 pop-exit)。
 */
export const ModalShell: React.FC<ModalShellProps> = ({
  onClose,
  children,
  overlayClassName = 'bg-black/60 backdrop-blur-sm',
  closeOnBackdrop = true,
  z = 200,
}) => {
  const { exiting, requestClose } = useModalExit(onClose);
  return (
    <ModalCloseContext.Provider value={requestClose}>
    <div
      className={`no-drag fixed inset-0 ${overlayClassName} flex items-center justify-center p-4 ${
        exiting ? 'overlay-exit' : 'overlay-enter'
      }`}
      style={{ zIndex: z }}
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
      onClick={(e) => {
        if (!closeOnBackdrop || e.target !== e.currentTarget) return;
        // 蒙版拖动窗口后松手不当作点击关闭
        if ((e.currentTarget as HTMLElement).dataset.dragged === '1') {
          (e.currentTarget as HTMLElement).dataset.dragged = '';
          return;
        }
        requestClose();
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1 && e.target === e.currentTarget) {
          (e.currentTarget as HTMLElement).dataset.dragged = '1';
        }
      }}
    >
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        const el = child as React.ReactElement<{ className?: string }>;
        return React.cloneElement(el, {
          className: `${el.props.className ?? ''} ${exiting ? 'pop-exit' : 'pop-enter'}`,
        });
      })}
    </div>
    </ModalCloseContext.Provider>
  );
};
