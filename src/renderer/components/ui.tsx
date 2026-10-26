import React from 'react';

/**
 * 全应用统一的表单控件样式常量与字段容器。
 * 改这里 = 改全局;新代码禁止再手写这些长类名串。
 */

/** 标准输入框/文本域类名(块级占满) */
export const inputCls =
  'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500';

/** 字段标题标签类名 */
export const fieldLabelCls =
  'block font-medium text-slate-700 dark:text-slate-300 mb-1';

/** 字段标题:与控件成组出现,统一 label 样式(可选 htmlFor 关联输入框) */
export const FieldLabel: React.FC<{
  children: React.ReactNode;
  htmlFor?: string;
}> = ({ children, htmlFor }) => (
  <label htmlFor={htmlFor} className={fieldLabelCls}>
    {children}
  </label>
);
