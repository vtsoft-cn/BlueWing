package cn.vtsoft.bluewing;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;

import java.net.InetAddress;
import java.util.StringJoiner;
import java.util.function.Consumer;

import mobile.Mobile;
import mobile.Session;
import proxymobile.Platform;
import proxymobile.Proxy;
import proxymobile.Proxymobile;

public final class CompanyVpnService extends VpnService {
    static final String CONNECT = "cn.vtsoft.bluewing.CONNECT";
    static final String CONNECT_PROXY = "cn.vtsoft.bluewing.CONNECT_PROXY";
    static final String DISCONNECT = "cn.vtsoft.bluewing.DISCONNECT";
    static volatile String currentStatus = "未连接";
    static volatile Consumer<String> statusListener;
    private static final String CHANNEL = "company-vpn";
    private static final int NOTIFICATION_ID = 1;
    private volatile Session activeSession;
    private volatile Proxy activeProxy;

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || DISCONNECT.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        boolean publicProxy = CONNECT_PROXY.equals(intent.getAction());
        if ((!publicProxy && !CONNECT.equals(intent.getAction())) || activeSession != null || activeProxy != null) {
            return START_NOT_STICKY;
        }
        if (VpnService.prepare(this) != null) {
            updateStatus("需要授权 Android VPN 接入");
            stopSelf();
            return START_NOT_STICKY;
        }
        showNotification(publicProxy);
        if (publicProxy) {
            String link = intent.getStringExtra("profile");
            intent.removeExtra("profile");
            Proxy proxy = Proxymobile.newProxy();
            activeProxy = proxy;
            updateStatus("正在启动公网代理");
            new Thread(() -> connectProxy(proxy, link), "bluewing-proxy").start();
            return START_NOT_STICKY;
        }
        String password = intent.getStringExtra("password");
        intent.removeExtra("password");
        Session session = Mobile.newSession();
        activeSession = session;
        updateStatus("正在连接");
        new Thread(() -> connect(session, intent, password, startId), "bluewing-vpn").start();
        return START_NOT_STICKY;
    }

    private void connectProxy(Proxy proxy, String link) {
        try {
            proxy.start(link, underlyingResolvers(), new Platform() {
                @Override public boolean protectProxySocket(int fd) {
                    return protect(fd);
                }

                @Override public int openProxyTun() throws Exception {
                    if (activeProxy != proxy) throw new IllegalStateException("连接已取消");
                    try (ParcelFileDescriptor tun = new Builder().setSession("BlueWing 公网代理")
                            .setMtu(1400).addAddress("172.19.0.1", 30).addAddress("fdfe:dcba:9876::1", 126)
                            .addRoute("0.0.0.0", 0).addRoute("::", 0).addDnsServer("172.19.0.2").establish()) {
                        if (tun == null) throw new IllegalStateException("系统未建立 VPN 接口");
                        return tun.detachFd();
                    }
                }
            });
            if (activeProxy == proxy) updateStatus("公网代理已启动");
        } catch (Exception error) {
            if (activeProxy == proxy) {
                updateStatus("公网代理启动失败，请检查节点链接与系统授权");
                stopSelf();
            }
        }
    }

    private void connect(Session session, Intent config, String password, int startId) {
        try {
            String routes = Mobile.normalizeRoutes(config.getStringExtra("routes"));
            String suffixes = config.getStringExtra("suffixes");
            String publicResolvers = "";
            if (!suffixes.isEmpty()) {
                publicResolvers = underlyingResolvers();
                if (publicResolvers.isEmpty()) throw new IllegalStateException("当前网络没有可用的 DNS");
            }
            session.connect(config.getStringExtra("host"), config.getIntExtra("port", 443),
                config.getStringExtra("hub"), config.getStringExtra("username"), password,
                config.getStringExtra("ca"), this::protect);
            Builder builder = new Builder().setSession("BlueWing 企业接入")
                .setMtu(1400).addAddress(session.address(), 32)
                .allowFamily(android.system.OsConstants.AF_INET6);
            for (String route : routes.split("\\n")) {
                String[] cidr = route.split("/");
                builder.addRoute(cidr[0], Integer.parseInt(cidr[1]));
            }
            if (!suffixes.isEmpty()) {
                String dns = Mobile.virtualDNSAddress();
                builder.addDnsServer(dns).addRoute(dns, 32).addRoute(session.dns(), 32);
            }
            if (activeSession != session) return;
            try (ParcelFileDescriptor tun = builder.establish()) {
                if (tun == null) throw new IllegalStateException("系统未建立 VPN 接口");
                if (activeSession != session) return;
                updateStatus("已连接 · 公司网段走 VPN");
                session.forward(tun.detachFd(), suffixes, publicResolvers);
            }
        } catch (Exception error) {
            if (activeSession == session) updateStatus("连接已停止，请检查网关、证书和接入配置");
        } finally {
            session.close();
            stopSelf(startId);
        }
    }

    private String underlyingResolvers() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        LinkProperties properties = manager.getLinkProperties(manager.getActiveNetwork());
        StringJoiner resolvers = new StringJoiner(" ");
        if (properties != null) {
            for (InetAddress address : properties.getDnsServers()) {
                if (!address.isAnyLocalAddress() && !address.isLoopbackAddress()) {
                    resolvers.add(address.getHostAddress());
                }
            }
        }
        return resolvers.toString();
    }

    @Override public void onRevoke() {
        stopSelf();
    }

    @Override public void onDestroy() {
        Session session = activeSession;
        activeSession = null;
        if (session != null) session.close();
        Proxy proxy = activeProxy;
        activeProxy = null;
        if (proxy != null) new Thread(proxy::close, "bluewing-proxy-close").start();
        if (currentStatus.startsWith("正在") || currentStatus.startsWith("已连接")
                || currentStatus.equals("公网代理已启动")) {
            updateStatus("未连接");
        }
        super.onDestroy();
    }

    private void updateStatus(String status) {
        currentStatus = status;
        Consumer<String> listener = statusListener;
        if (listener != null) listener.accept(status);
    }

    private void showNotification(boolean publicProxy) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL, "BlueWing VPN", NotificationManager.IMPORTANCE_LOW));
        int pendingFlags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class), pendingFlags);
        PendingIntent disconnect = PendingIntent.getService(this, 1,
            new Intent(this, CompanyVpnService.class).setAction(DISCONNECT), pendingFlags);
        startForeground(NOTIFICATION_ID, new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle(publicProxy ? "BlueWing 公网代理" : "BlueWing 企业接入")
            .setContentText(publicProxy ? "公网流量通过代理节点" : "公司网段通过 VPN 接入")
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, "断开", disconnect).build())
            .setOngoing(true).build());
    }
}
