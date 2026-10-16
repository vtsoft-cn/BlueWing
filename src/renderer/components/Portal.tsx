import React from 'react';
import { createPortal } from 'react-dom';

/**
 * 把浮层(弹窗/蒙版)挂载到 document.body:
 * 避免 fixed 定位受页面内祖先元素(入场动画 transform / backdrop-filter 等)
 * 形成的包含块影响,保证蒙版始终覆盖整个视口。
 */
export const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  createPortal(children, document.body);
