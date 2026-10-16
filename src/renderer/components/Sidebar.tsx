import React from 'react';
import {
  Home,
  Server,
  Rss,
  GitFork,
  LayoutGrid,
  Globe,
  Gauge,
  Terminal,
  CloudUpload,
  Settings,
  Info,
} from 'lucide-react';
import logoDark from '../../images/png/app-dark-off.png';
import logoLight from '../../images/png/app-light-off.png';

export type NavTab =
  | 'dashboard'
  | 'nodes'
  | 'subscriptions'
  | 'routing'
  | 'app-routing'
  | 'dns'
  | 'speedtest'
  | 'logs'
  | 'backup'
  | 'settings'
  | 'about';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  theme: 'light' | 'dark';
}

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab, theme }) => {

  const navItems: { id: NavTab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: '首页', icon: <Home className="w-4 h-4" /> },
    { id: 'nodes', label: '节点', icon: <Server className="w-4 h-4" /> },
    { id: 'subscriptions', label: '订阅', icon: <Rss className="w-4 h-4" /> },
    { id: 'routing', label: '路由', icon: <GitFork className="w-4 h-4" /> },
    { id: 'app-routing', label: '应用分流', icon: <LayoutGrid className="w-4 h-4" /> },
    { id: 'dns', label: 'DNS', icon: <Globe className="w-4 h-4" /> },
    { id: 'speedtest', label: '测速', icon: <Gauge className="w-4 h-4" /> },
    { id: 'logs', label: '日志', icon: <Terminal className="w-4 h-4" /> },
    { id: 'backup', label: '备份', icon: <CloudUpload className="w-4 h-4" /> },
  ];

  return (
    <aside className="w-56 h-full flex flex-col justify-between border-r border-slate-200/80 dark:border-slate-800/80 bg-white/50 dark:bg-slate-900/50 backdrop-blur-md p-3 select-none flex-shrink-0">
      {/* Top Branding(空白区域可拖动窗口,全局规则) */}
      <div className="space-y-4">
        <div className="flex items-center space-x-3 px-2 py-1">
          <img
            src={theme === 'dark' ? logoDark : logoLight}
            alt="青鸟 BlueBird"
            draggable={false}
            className="w-8 h-8 rounded-lg shadow-sm select-none"
          />
          <div>
            <h1 className="font-bold text-sm tracking-tight text-slate-800 dark:text-slate-100">
              青鸟 BlueBird
            </h1>
            <p className="text-[11px] text-slate-400 font-normal">PC 代理工具链</p>
          </div>
        </div>

        {/* Main Navigation */}
        <nav className="space-y-1">
          {navItems.map((item) => {
            const active = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                  active
                    ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/25 dark:bg-blue-600'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100/70 dark:hover:bg-slate-800/60'
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Area: Settings & About */}
      <div className="space-y-2 pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
        <button
          onClick={() => onSelectTab('settings')}
          className={`w-full flex items-center space-x-3 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            currentTab === 'settings'
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100/70 dark:hover:bg-slate-800/60'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>设置</span>
        </button>

        <button
          onClick={() => onSelectTab('about')}
          className={`w-full flex items-center space-x-3 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            currentTab === 'about'
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100/70 dark:hover:bg-slate-800/60'
          }`}
        >
          <Info className="w-4 h-4" />
          <span>关于</span>
        </button>
      </div>
    </aside>
  );
};
