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

/** 标准输入框:样式取自 inputCls,额外 className 追加在后 */
export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({
  className = '',
  ...rest
}) => <input {...rest} className={`${inputCls} ${className}`.trimEnd()} />;

/** 标准多行文本框:样式同 Input */
export const Textarea: React.FC<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
> = ({ className = '', ...rest }) => (
  <textarea {...rest} className={`${inputCls} ${className}`.trimEnd()} />
);

type ButtonVariant = 'primary' | 'ghost' | 'danger';

const btnVariantCls: Record<ButtonVariant, string> = {
  primary:
    'bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 text-white shadow-sm shadow-blue-500/25',
  ghost:
    'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800',
  danger: 'bg-red-600 hover:bg-red-700 text-white',
};

/** 标准按钮:34px 高、8px 圆角、12px 字;primary=主操作 ghost=取消/次要 danger=危险 */
export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }
> = ({ variant = 'primary', className = '', type = 'button', ...rest }) => (
  <button
    type={type}
    {...rest}
    className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${btnVariantCls[variant]} ${className}`.trimEnd()}
  />
);
