import React, { useState, useEffect, useRef } from 'react';
import { Sidebar, NavTab } from './components/Sidebar';
import { PageHeader } from './components/PageHeader';
import { ToastHost, toast } from './components/Toast';
import { ConfirmDialogHost, confirmDialog } from './components/ConfirmDialog';
import { Dashboard } from './pages/Dashboard';
import { Nodes } from './pages/Nodes';
import { Subscriptions } from './pages/Subscriptions';
import { Routing } from './pages/Routing';
import { AppRouting } from './pages/AppRouting';
import { DNS } from './pages/DNS';
import { SpeedTest } from './pages/SpeedTest';
import { Logs } from './pages/Logs';
import { Backup } from './pages/Backup';
import { Settings } from './pages/Settings';
import { About } from './pages/About';
import { VpnAccess, VpnAccessStatus } from './pages/VpnAccess';
import {
  ProxyNode,
  Subscription,
  RouteRule,
  AppRule,
  DnsConfig,
  AppSettings,
  TrafficStats,
} from '../types';

// 首帧主题初始值:与 index.html 的早期脚本一致——优先取上次使用的主题设置,首次启动跟随系统
const initialTheme: AppSettings['theme'] = (() => {
  try {
    const t = localStorage.getItem('bluewing:theme');
    if (t === 'dark' || t === 'light' || t === 'system') return t;
  } catch {}
  return 'system';
})();

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<NavTab>('dashboard');

  const [coreState, setCoreState] = useState<string>('stopped');
  // stateChange 事件序号:loadAllData 的 core:getState 快照仅在拉取窗口内无新事件时应用
  const coreEventSeqRef = useRef(0);
  const [coreVersion, setCoreVersion] = useState<string>('1.14.3');
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string>('');
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [rules, setRules] = useState<RouteRule[]>([]);
  const [appRules, setAppRules] = useState<AppRule[]>([]);
  const [dns, setDns] = useState<DnsConfig>({
    mode: 'standard',
    remoteDns: 'https://1.1.1.1/dns-query',
    directDns: '223.5.5.5',
    fakeIpRange: '198.18.0.0/15',
    enableDnsRouting: true,
    servers: [],
  });
  const [settings, setSettings] = useState<AppSettings>({
    theme: initialTheme,
    language: 'zh-CN',
    startOnBoot: false,
    startMinimized: false,
    autoConnectOnLaunch: false,
    closeToTray: true,
    mixedPort: 2080,
    allowLan: false,
    inboundAuth: false,
    systemProxyEnabled: true,
    systemProxyBypassLan: true,
    tunEnabled: false,
    tunMtu: 9000,
    tunStack: 'system',
    tunAutoRoute: true,
    tunStrictRoute: false,
    tunDnsHijack: true,
    tunIPv6: false,
    routingMode: 'rule',
    logLevel: 'info',
    clashApiEnabled: true,
    clashApiPort: 9090,
    testUrl: 'http://cp.cloudflare.com/generate_204',
    testTimeoutMs: 5000,
    testConcurrent: 8,
    webdav: {
      serverUrl: '',
      username: '',
      password: '',
      remotePath: 'BlueWingConnect',
      autoSync: false,
    },
  });

  const [traffic, setTraffic] = useState<TrafficStats>({
    downloadSpeed: 0,
    uploadSpeed: 0,
    totalDownload: 0,
    totalUpload: 0,
    latency: 0,
    uptime: 0,
    activeConnections: 0,
  });

  // 系统深浅色模式实时跟随(修复:此前无监听,系统切换主题需重启应用才生效)
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  // Load initial data
  const loadAllData = async () => {
    if (!window.electronAPI) return;
    const seqBeforeFetch = coreEventSeqRef.current;
    try {
      const [
        loadedNodes,
        loadedActiveId,
        loadedSubs,
        loadedRules,
        loadedAppRules,
        loadedDns,
        loadedSettings,
        loadedState,
        loadedVer,
      ] = await Promise.all([
        window.electronAPI.nodes.getAll(),
        window.electronAPI.nodes.getActiveId(),
        window.electronAPI.subscriptions.getAll(),
        window.electronAPI.routing.getRules(),
        window.electronAPI.routing.getAppRules(),
        window.electronAPI.dns.get(),
        window.electronAPI.settings.get(),
        window.electronAPI.core.getState(),
        window.electronAPI.core.getVersion(),
      ]);

      if (loadedNodes) setNodes(loadedNodes);
      if (loadedActiveId) setActiveNodeId(loadedActiveId);
      if (loadedSubs) setSubscriptions(loadedSubs);
      if (loadedRules) setRules(loadedRules);
      if (loadedAppRules) setAppRules(loadedAppRules);
      if (loadedDns) setDns(loadedDns);
      if (loadedSettings) setSettings(loadedSettings);
      // coreState 快照仅在拉取期间没有任何 stateChange 事件到达时才应用:
      // 事件是推送语义、必然不旧于快照;否则会出现"删除订阅触发停止→事件已到 stopped,
      // 而被 getVersion 拖慢的 Promise.all 随后用过期的 starting/stopping 快照覆盖",
      // 首页永久卡"连接中"且按钮禁用无法停止(主进程实际早已 stopped)。
      if (loadedState && coreEventSeqRef.current === seqBeforeFetch) setCoreState(loadedState);
      if (loadedVer) setCoreVersion(loadedVer);
    } catch (e) {
      console.error('Error loading initial data:', e);
    }
  };

  useEffect(() => {
    loadAllData();

    if (window.electronAPI) {
      const unsubState = window.electronAPI.core.onStateChange((state) => {
        coreEventSeqRef.current++;
        setCoreState(state);
      });
      const unsubTraffic = window.electronAPI.core.onTraffic((t) => {
        setTraffic(t);
      });
      // 托盘发起的变更(节点切换/系统代理/TUN)同步到 UI
      const unsubNode = window.electronAPI.nodes.onNodeChanged((id) => {
        setActiveNodeId(id);
      });
      // 主进程为节点列表唯一事实源:订阅更新(含后台自动)/备份导入/增删改后统一刷新
      const unsubNodes = window.electronAPI.nodes.onNodesChanged((list) => {
        setNodes(list);
      });
      const unsubSubs = window.electronAPI.subscriptions.onSubsChanged((subs) => {
        setSubscriptions(subs);
      });
      const unsubRules = window.electronAPI.routing.onRulesChanged((rules) => {
        setRules(rules);
      });
      const unsubAppRules = window.electronAPI.routing.onAppRulesChanged((appRules) => {
        setAppRules(appRules);
      });
      const unsubDns = window.electronAPI.dns.onDnsChanged((dnsCfg) => {
        setDns(dnsCfg);
      });
      const unsubSettings = window.electronAPI.settings.onSettingsChanged((s) => {
        setSettings(s);
      });

      return () => {
        unsubState();
        unsubTraffic();
        unsubNode();
        unsubNodes();
        unsubSubs();
        unsubRules();
        unsubAppRules();
        unsubDns();
        unsubSettings();
      };
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Theme effect
  const isDark = settings.theme === 'dark' || (settings.theme === 'system' && systemDark);

  useEffect(() => {
    // 持久化主题设置,供下次启动的 index.html 早期脚本用作首帧初始值
    try {
      localStorage.setItem('bluewing:theme', settings.theme);
    } catch {}
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark, settings.theme]);

  // Connect Toggle
  const handleToggleConnect = async () => {
    if (!window.electronAPI) return;
    if (coreState === 'running') {
      await window.electronAPI.core.stop();
    } else {
      await window.electronAPI.core.start();
    }
  };

  // Node select
  const selectingExit = useRef(false);
  const handleSelectNode = async (id: string) => {
    if (!window.electronAPI || selectingExit.current) return;
    selectingExit.current = true;
    try {
      const success = await window.electronAPI.nodes.setActiveId(id);
      setActiveNodeId(await window.electronAPI.nodes.getActiveId());
      setSettings(await window.electronAPI.settings.get());
      if (!success) toast.error('代理出口应用失败，请检查日志后重新连接');
    } catch {
      toast.error('切换代理出口失败，请重试');
    } finally { selectingExit.current = false; }
  };
  const handleSelectDirect = async () => {
    if (!window.electronAPI || selectingExit.current) return;
    selectingExit.current = true;
    try {
      const success = await window.electronAPI.nodes.selectDirect();
      setSettings(await window.electronAPI.settings.get());
      if (!success) toast.error('直连出口应用失败，请检查日志后重新连接');
    } catch {
      toast.error('切换本机直连失败，请重试');
    } finally { selectingExit.current = false; }
  };

  // Save Subscriptions
  const handleSaveSubscriptions = async (newSubs: Subscription[]) => {
    setSubscriptions(newSubs);
    if (window.electronAPI) {
      await window.electronAPI.subscriptions.save(newSubs);
    }
  };

  // Save Routing Rules
  const handleSaveRules = async (newRules: RouteRule[]) => {
    setRules(newRules);
    if (window.electronAPI) {
      await window.electronAPI.routing.saveRules(newRules);
    }
  };

  // Save App Rules
  const handleSaveAppRules = async (newRules: AppRule[]) => {
    setAppRules(newRules);
    if (window.electronAPI) {
      await window.electronAPI.routing.saveAppRules(newRules);
    }
  };

  // Save DNS
  const handleSaveDns = async (newDns: DnsConfig) => {
    setDns(newDns);
    if (window.electronAPI) {
      await window.electronAPI.dns.save(newDns);
    }
  };

  // Update Settings
  const handleUpdateSettings = async (partial: Partial<AppSettings>) => {
    const merged = { ...settings, ...partial };
    setSettings(merged);
    if (window.electronAPI) {
      await window.electronAPI.settings.save(merged);
    }
  };

  // TUN 提权引导:统一走应用内自定义确认框(不使用系统原生对话框)。
  // 覆盖入口:Dashboard/设置页开 TUN 的预检、托盘勾选、主进程兜底拦截事件,
  // 以及连接门禁(context='connect':TUN 已开启但非管理员时点连接,主进程拒绝
  // 启动并弹窗——取消即关闭 TUN 改用系统代理连接,不让 TUN 开关"假开启")
  const handleRequestTunElevation = async (context?: string) => {
    const isConnect = context === 'connect';
    const ok = await confirmDialog({
      title: '启用 TUN 需要管理员权限',
      message: isConnect
        ? '当前 TUN 模式已开启,但应用以普通用户权限运行,连接无法启用 TUN。可以管理员身份重启应用后启用 TUN;或关闭 TUN,本次连接改用系统代理。'
        : '当前应用以普通用户权限运行,TUN 无法生效。可以管理员身份重启应用后启用 TUN(若系统开启 UAC 提示会请求确认一次,静默提升的系统则直接重启);选择取消则不开启 TUN,继续使用系统代理。',
      confirmText: '以管理员身份重启',
      cancelText: isConnect ? '改用系统代理连接' : '取消',
    });
    if (ok) {
      if (window.electronAPI?.tun) {
        await window.electronAPI.tun.enableElevated();
      }
      return;
    }
    if (isConnect && window.electronAPI) {
      // 改用系统代理:以主进程最新设置为基准仅翻转 TUN(订阅闭包里的渲染层
      // settings 可能过期,直接回写会连旧字段一起落库),连接意图保护会自动
      // 补开系统代理;先 await 设置落库再连接,避免门禁重读到旧 tunEnabled
      const cur = await window.electronAPI.settings.get();
      await window.electronAPI.settings.save({ ...cur, tunEnabled: false });
      await window.electronAPI.core.start();
    }
  };

  useEffect(() => {
    const unsubscribe = window.electronAPI?.tun?.onElevationRequired((context) => {
      handleRequestTunElevation(context);
    });
    return unsubscribe;
  }, []);

  const activeNode = nodes.find((n) => n.id === activeNodeId) || nodes[0];

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-100/70 dark:bg-slate-950 text-slate-800 dark:text-slate-100">
      {/* Workspace Body: Sidebar 通顶 + 右侧(页头 + 内容);空白区域可拖动窗口 */}
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          theme={isDark ? 'dark' : 'light'}
        />

        {/* Right Column: PageHeader + Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <PageHeader
            coreState={coreState}
            activeNodeName={settings.routingMode === 'direct' || nodes.length === 0 ? '本机直连' : activeNode?.name}
            latency={settings.routingMode === 'direct' || nodes.length === 0 ? undefined : activeNode?.ping}
          />
          <VpnAccessStatus showSummary={currentTab !== 'vpn-access'} onOpen={() => setCurrentTab('vpn-access')} />

          {/* Main Content Area(key 随页签变化,触发入场动画;no-drag 保证滚动条可交互) */}
          <main className="flex-1 overflow-y-auto p-6 no-drag">
          <div key={currentTab} className="max-w-5xl mx-auto page-enter">
            {currentTab === 'dashboard' && (
              <Dashboard
                coreState={coreState}
                coreVersion={coreVersion}
                onToggleConnect={handleToggleConnect}
                nodes={nodes}
                activeNodeId={activeNodeId}
                onSelectNode={handleSelectNode}
                onSelectDirect={handleSelectDirect}
                traffic={traffic}
                settings={settings}
                onUpdateSettings={handleUpdateSettings}
                onNavigate={setCurrentTab}
                onRequestTunElevation={handleRequestTunElevation}
              />
            )}

            {currentTab === 'nodes' && (
              <Nodes
                nodes={nodes}
                activeNodeId={activeNodeId}
                onSelectNode={handleSelectNode}
                onSelectDirect={handleSelectDirect}
                directSelected={settings.routingMode === 'direct' || nodes.length === 0}
                selectionDisabled={coreState === 'starting' || coreState === 'stopping'}
                subscriptions={subscriptions}
              />
            )}

            {currentTab === 'subscriptions' && (
              <Subscriptions
                subscriptions={subscriptions}
                onSaveSubscriptions={handleSaveSubscriptions}
                onRefreshNodes={loadAllData}
              />
            )}

            {currentTab === 'routing' && (
              <Routing
                rules={rules}
                onSaveRules={handleSaveRules}
                settings={settings}
                onUpdateSettings={handleUpdateSettings}
                nodes={nodes}
              />
            )}

            {currentTab === 'app-routing' && (
              <AppRouting appRules={appRules} onSaveAppRules={handleSaveAppRules} />
            )}

            {currentTab === 'dns' && <DNS dns={dns} onSaveDns={handleSaveDns} />}
            {currentTab === 'vpn-access' && (
              <VpnAccess settings={settings} coreState={coreState}
                publicProxy={{ enabled: !!activeNode && settings.routingMode !== 'direct', name: activeNode?.name, mode: settings.routingMode }} />
            )}

            {currentTab === 'speedtest' && (
              <SpeedTest
                nodes={nodes}
                activeNodeId={activeNodeId}
                onSelectNode={handleSelectNode}
              />
            )}

            {currentTab === 'logs' && <Logs />}

            {currentTab === 'backup' && (
              <Backup
                settings={settings}
                onUpdateSettings={handleUpdateSettings}
                onRefreshAllData={loadAllData}
              />
            )}

            {currentTab === 'settings' && (
              <Settings
                settings={settings}
                onUpdateSettings={handleUpdateSettings}
                coreVersion={coreVersion}
                onRequestTunElevation={handleRequestTunElevation}
              />
            )}

            {currentTab === 'about' && (
              <About theme={isDark ? 'dark' : 'light'} coreVersion={coreVersion} />
            )}
          </div>
        </main>
        </div>
      </div>

      {/* 全局轻提示与确认对话框 */}
      <ToastHost />
      <ConfirmDialogHost />
    </div>
  );
};

export default App;
