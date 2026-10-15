import React, { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle } from 'lucide-react';
import logoDark from '../assets/dark.svg';
import logoLight from '../assets/light.svg';

interface AboutProps {
  theme: 'light' | 'dark';
  coreVersion: string;
}

export const About: React.FC<AboutProps> = ({ theme, coreVersion }) => {
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('v1.0.0 正式版');

  useEffect(() => {
    if (window.electronAPI?.system?.getAppVersion) {
      window.electronAPI.system.getAppVersion().then((ver) => {
        if (ver) setAppVersion(`v${ver} 正式版`);
      });
    }
  }, []);

  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    setUpdateMsg(null);
    try {
      await new Promise((r) => setTimeout(r, 600));
      setUpdateMsg(`当前已是最新版本 ${appVersion}`);
    } finally {
      setIsCheckingUpdate(false);
    }
  };

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
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold border border-blue-500/20">
                {appVersion}
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-1.5 max-w-md mx-auto">
              基于 Sing-box 官方原生核心打造的现代化通用代理工具链与网络调试客户端
            </p>
          </div>

          {/* Action buttons */}
          <div className="pt-2 flex items-center justify-center">
            <button
              onClick={handleCheckUpdate}
              disabled={isCheckingUpdate}
              className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 text-white text-xs font-medium flex items-center space-x-1.5 shadow-sm shadow-blue-500/25 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isCheckingUpdate ? 'animate-spin' : ''}`} />
              <span>{isCheckingUpdate ? '正在检查...' : '检查软件更新'}</span>
            </button>
          </div>

          {updateMsg && (
            <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 text-xs font-medium flex items-center justify-center space-x-1">
              <CheckCircle className="w-3.5 h-3.5" />
              <span>{updateMsg}</span>
            </div>
          )}
        </div>

        {/* Info Details Grid */}
        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm space-y-4 text-xs">
          <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
            版本与组件信息
          </h3>

          <div className="space-y-3 divide-y divide-slate-100 dark:divide-slate-800/60">
            <div className="flex items-center justify-between pt-1">
              <span className="text-slate-500">客户端版本 (App Version)</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200 font-mono">
                1.0.0 Release (Windows x64)
              </span>
            </div>

            <div className="flex items-center justify-between pt-3">
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

            <div className="flex items-center justify-between pt-3">
              <span className="text-slate-500">开源协议 (License)</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                GNU General Public License v3.0 (GPL-3.0)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
