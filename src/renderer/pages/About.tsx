import React from 'react';
import logoDark from '../assets/dark.png';
import logoLight from '../assets/light.png';

interface AboutProps {
  theme: 'light' | 'dark';
  coreVersion: string;
}

export const About: React.FC<AboutProps> = ({ theme, coreVersion }) => {

  return (
    <div className="min-h-full flex items-center justify-center p-2">
      <div className="space-y-5 w-full max-w-2xl">
        {/* Brand Hero Card */}
        <div className="p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 shadow-sm text-center space-y-4 relative overflow-hidden">
          <div className="w-24 h-24 mx-auto">
            <img
              src={theme === 'dark' ? logoDark : logoLight}
              alt="青鸟 BlueBird Logo"
              draggable={false}
              className="w-full h-full object-contain"
            />
          </div>

          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 flex items-center justify-center gap-2">
              青鸟 BlueBird
            </h2>
            <p className="text-xs text-slate-400 mt-1.5 max-w-md mx-auto">
              基于 Sing-box 官方原生核心打造的现代化通用代理工具链与网络调试客户端
            </p>
          </div>
        </div>

        {/* Info Details Grid */}
        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm space-y-4 text-xs">
          <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
            组件信息
          </h3>

          <div className="space-y-3 divide-y divide-slate-100 dark:divide-slate-800/60">
            <div className="flex items-center justify-between pt-1">
              <span className="text-slate-500">Sing-box 官方核心版本</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200 font-mono">
                {coreVersion}
              </span>
            </div>

            <div className="flex items-center justify-between pt-3">
              <span className="text-slate-500">Wintun 网卡驱动</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200 font-mono">
                0.14.1 (amd64)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
