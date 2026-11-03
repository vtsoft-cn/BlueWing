package cn.vtsoft.bluewing;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.net.VpnService;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.function.Consumer;

import mobile.Mobile;

public final class MainActivity extends Activity {
    private static final int VPN_PERMISSION = 1;
    private EditText profile, host, port, hub, username, password, routes, suffixes, ca;
    private TextView status, statusDot, nodeTitle, nodeDetail, companyStatus, nodeSelection;
    private ImageView powerIcon;
    private Button primary, companyConnect, companyDisconnect;
    private ScrollView scroll;
    private LinearLayout companyActions;
    private LinearLayout[] pages;
    private Button[] tabs;
    private boolean dark;
    private int background, surface, border, ink, muted, blue, blueTint;
    private int currentPage;
    private String selectedLink = "";
    private Intent pending;
    private final Consumer<String> statusListener =
        message -> runOnUiThread(() -> renderStatus(message));

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        background = color(0xf8fafc, 0x020617);
        surface = color(0xffffff, 0x0f172a);
        border = color(0xe2e8f0, 0x253248);
        ink = color(0x0f172a, 0xf1f5f9);
        muted = color(0x475569, 0x94a3b8);
        blue = color(0x1d4ed8, 0x93c5fd);
        blueTint = color(0xeff6ff, 0x172c4b);
        getWindow().getDecorView().setSystemUiVisibility(dark ? 0 :
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        LinearLayout root = column();
        root.setBackgroundColor(background);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        root.addView(brandHeader());
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setScrollBarSize(dp(2));
        scroll.setPadding(dp(20), dp(16), dp(20), dp(20));
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout content = column();
        scroll.addView(content);
        pages = new LinearLayout[]{column(), column(), column()};
        for (LinearLayout page : pages) content.addView(page);
        buildHome(pages[0]);
        buildNodes(pages[1]);
        buildCompany(pages[2]);
        root.addView(companyActions);
        root.addView(navigation());
        setContentView(root);
        showPage(0);
        updateNodeSummary();
    }

    private LinearLayout brandHeader() {
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(20), dp(12), dp(20), dp(12));
        ImageView logo = new ImageView(this);
        logo.setImageResource(dark ? R.drawable.bluewing_dark : R.drawable.bluewing_light);
        header.addView(logo, new LinearLayout.LayoutParams(dp(40), dp(40)));
        LinearLayout brand = column();
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
        params.leftMargin = dp(10);
        header.addView(brand, params);
        brand.addView(label("BlueWing Connect", 18, ink, true));
        brand.addView(label("代理与网络接入", 12, muted, false));
        return header;
    }

    private void buildHome(LinearLayout page) {
        heading(page, "连接概览", "管理当前出口与企业网络");
        LinearLayout hero = card(page, true);
        powerIcon = new ImageView(this);
        powerIcon.setImageResource(R.drawable.status_power);
        powerIcon.setScaleType(ImageView.ScaleType.CENTER);
        powerIcon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams powerLayout = new LinearLayout.LayoutParams(dp(70), dp(70));
        powerLayout.gravity = Gravity.CENTER_HORIZONTAL;
        powerLayout.topMargin = dp(5);
        hero.addView(powerIcon, powerLayout);
        LinearLayout state = new LinearLayout(this);
        state.setGravity(Gravity.CENTER_VERTICAL);
        state.setPadding(dp(10), dp(5), dp(10), dp(5));
        state.setBackground(shape(surface, border, 30));
        statusDot = label("●", 9, muted, true);
        state.addView(statusDot, new LinearLayout.LayoutParams(dp(16), -2));
        status = label("未连接", 15, ink, true);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        state.addView(status);
        LinearLayout.LayoutParams stateLayout = new LinearLayout.LayoutParams(-2, -2);
        stateLayout.gravity = Gravity.CENTER_HORIZONTAL;
        stateLayout.topMargin = dp(12);
        hero.addView(state, stateLayout);
        add(hero, label("当前网络出口", 12, muted, true), 16);
        LinearLayout outlet = column();
        outlet.setPadding(dp(12), dp(10), dp(12), dp(10));
        outlet.setBackground(touch(surface, border, 14));
        outlet.setFocusable(true);
        outlet.setOnClickListener(view -> showPage(1));
        nodeTitle = label("", 16, ink, true);
        nodeTitle.setSingleLine(true);
        nodeTitle.setEllipsize(TextUtils.TruncateAt.END);
        outlet.addView(nodeTitle);
        add(outlet, nodeDetail = label("", 13, muted, false), 4);
        add(hero, outlet, 8);
        primary = action("立即连接代理", true);
        primary.setOnClickListener(view -> {
            if (active(CompanyVpnService.currentStatus)) {
                disconnect();
            } else if (selectedLink.isEmpty()) {
                showPage(1);
            } else {
                requestConnection(new Intent(this, CompanyVpnService.class)
                    .setAction(CompanyVpnService.CONNECT_PROXY).putExtra("profile", selectedLink));
            }
        });
        add(hero, primary, 16);

        add(page, label("网络接入", 14, muted, true), 20);
        LinearLayout access = card(page, false);
        access.setBackground(touch(surface, border, 18));
        access.setFocusable(true);
        access.setOnClickListener(view -> showPage(2));
        LinearLayout accessRow = new LinearLayout(this);
        accessRow.setGravity(Gravity.CENTER_VERTICAL);
        ImageView accessIcon = new ImageView(this);
        accessIcon.setImageResource(R.drawable.nav_vpn);
        accessIcon.setImageTintList(ColorStateList.valueOf(color(0x047857, 0x6ee7b7)));
        accessIcon.setBackground(shape(color(0xecfdf5, 0x10352f), 0, 12));
        accessIcon.setScaleType(ImageView.ScaleType.CENTER);
        accessRow.addView(accessIcon, new LinearLayout.LayoutParams(dp(44), dp(44)));
        LinearLayout accessCopy = column();
        LinearLayout.LayoutParams accessCopyLayout = new LinearLayout.LayoutParams(0, -2, 1);
        accessCopyLayout.leftMargin = dp(12);
        accessRow.addView(accessCopy, accessCopyLayout);
        accessCopy.addView(label("企业 VPN 接入", 16, ink, true));
        add(accessCopy, label("使用 SoftEther 访问公司内网", 13, muted, false), 4);
        accessRow.addView(label("›", 23, muted, false));
        access.addView(accessRow);
    }

    private void buildNodes(LinearLayout page) {
        heading(page, "节点", "配置公网代理使用的网络出口");
        LinearLayout selected = card(page, true);
        selected.addView(label("当前节点", 13, blue, true));
        nodeSelection = label("尚未选择节点", 18, ink, true);
        nodeSelection.setMaxLines(2);
        nodeSelection.setEllipsize(TextUtils.TruncateAt.END);
        add(selected, nodeSelection, 6);
        LinearLayout card = card(page, false);
        card.addView(label("导入代理节点", 17, ink, true));
        add(card, label("支持 VLESS TLS 和 Reality 分享链接。链接仅保留在本次运行中。", 14, muted, false), 6);
        profile = field(card, "vless://…",
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        profile.setMinLines(3);
        profile.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        Button select = action("使用此节点", true);
        select.setOnClickListener(view -> {
            String link = profile.getText().toString().trim();
            if (!link.startsWith("vless://") || TextUtils.isEmpty(Uri.parse(link).getHost())) {
                profile.setError("请粘贴有效的 VLESS 节点链接");
                return;
            }
            if (active(CompanyVpnService.currentStatus)) {
                profile.setError("请先断开当前连接，再更换节点");
                return;
            }
            selectedLink = link;
            updateNodeSummary();
            showPage(0);
        });
        add(card, select, 14);
    }

    private void buildCompany(LinearLayout page) {
        heading(page, "企业 VPN 接入", "连接 SoftEther 网关，访问公司内网");
        companyStatus = label("未连接", 14, muted, true);
        add(page, companyStatus, 12);
        LinearLayout companyPanel = card(page, false);
        companyPanel.addView(label("网关与认证", 17, ink, true));
        LinearLayout gateway = new LinearLayout(this);
        add(companyPanel, gateway, 4);
        LinearLayout addressColumn = column();
        gateway.addView(addressColumn, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout portColumn = column();
        LinearLayout.LayoutParams portLayout = new LinearLayout.LayoutParams(dp(86), -2);
        portLayout.leftMargin = dp(10);
        gateway.addView(portColumn, portLayout);
        host = field(addressColumn, "SoftEther 网关主机名", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        port = field(portColumn, "端口", InputType.TYPE_CLASS_NUMBER);
        port.setContentDescription("网关端口");
        port.setText("443");
        hub = field(companyPanel, "Virtual HUB", InputType.TYPE_CLASS_TEXT);
        username = field(companyPanel, "账号", InputType.TYPE_CLASS_TEXT);
        password = field(companyPanel, "密码", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        companyPanel = card(page, false);
        companyPanel.addView(label("公司资源", 17, ink, true));
        routes = field(companyPanel, "公司 IPv4 网段，每行一个，例如 10.20.0.0/16",
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        Button advanced = action("DNS 与证书（可选）  ＋", false);
        add(companyPanel, advanced, 10);
        LinearLayout details = column();
        details.setVisibility(View.GONE);
        companyPanel.addView(details);
        advanced.setOnClickListener(view -> {
            boolean expanded = details.getVisibility() == View.VISIBLE;
            details.setVisibility(expanded ? View.GONE : View.VISIBLE);
            advanced.setText(expanded ? "DNS 与证书（可选）  ＋" : "DNS 与证书（可选）  −");
        });
        suffixes = field(details, "公司 DNS 后缀，例如 corp.example",
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        ca = field(details, "公司 CA 证书 PEM",
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        companyConnect = action("连接企业 VPN", true);
        companyConnect.setOnClickListener(view -> prepareConnection());
        companyDisconnect = action("断开当前连接", false);
        companyDisconnect.setOnClickListener(view -> disconnect());
        companyActions = column();
        companyActions.setBackgroundColor(background);
        companyActions.setPadding(dp(20), dp(6), dp(20), dp(10));
        companyActions.addView(companyConnect);
        companyActions.addView(companyDisconnect);
    }

    private LinearLayout column() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        return panel;
    }

    private LinearLayout navigation() {
        LinearLayout navigation = new LinearLayout(this);
        navigation.setBackground(shape(surface, border, 0));
        navigation.setPadding(dp(12), dp(6), dp(12), dp(6));
        String[] names = {"首页", "节点", "VPN 接入"};
        int[] icons = {R.drawable.nav_home, R.drawable.nav_nodes, R.drawable.nav_vpn};
        tabs = new Button[names.length];
        for (int index = 0; index < names.length; index++) {
            final int target = index;
            Button tab = action(names[index], false);
            tab.setTextSize(12);
            tab.setCompoundDrawablePadding(dp(4));
            tab.setCompoundDrawablesWithIntrinsicBounds(0, icons[index], 0, 0);
            tab.setOnClickListener(view -> showPage(target));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
            params.setMargins(dp(3), 0, dp(3), 0);
            navigation.addView(tab, params);
            tabs[index] = tab;
        }
        return navigation;
    }

    private void showPage(int selected) {
        currentPage = selected;
        companyActions.setVisibility(selected == 2 ? View.VISIBLE : View.GONE);
        for (int index = 0; index < pages.length; index++) {
            boolean visible = index == selected;
            pages[index].setVisibility(visible ? View.VISIBLE : View.GONE);
            tabs[index].setSelected(visible);
            tabs[index].setTextColor(visible ? blue : muted);
            tabs[index].setCompoundDrawableTintList(ColorStateList.valueOf(visible ? blue : muted));
            tabs[index].setBackground(touch(visible ? blueTint : surface, 0, 12));
        }
        scroll.scrollTo(0, 0);
        renderStatus(CompanyVpnService.currentStatus);
    }

    private void heading(LinearLayout page, String title, String subtitle) {
        page.addView(label(title, 26, ink, true));
        add(page, label(subtitle, 14, muted, false), 5);
    }

    private LinearLayout card(LinearLayout page, boolean highlight) {
        LinearLayout card = column();
        card.setPadding(dp(17), dp(16), dp(17), dp(16));
        GradientDrawable fill = shape(surface, border, 18);
        if (highlight) {
            fill.setOrientation(GradientDrawable.Orientation.TL_BR);
            fill.setColors(new int[]{surface, blueTint});
        }
        card.setBackground(fill);
        add(page, card, 14);
        return card;
    }

    private TextView label(String value, int size, int textColor, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(textColor);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private Button action(String title, boolean emphasized) {
        Button button = new Button(this);
        button.setText(title);
        button.setTextSize(15);
        button.setAllCaps(false);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setStateListAnimator(null);
        button.setMinHeight(dp(48));
        button.setPadding(dp(12), dp(10), dp(12), dp(10));
        styleAction(button, emphasized, false);
        return button;
    }

    private void styleAction(Button button, boolean emphasized, boolean disconnect) {
        int fill = disconnect ? 0xffb91c1c : emphasized ? 0xff2563eb : surface;
        button.setTextColor(emphasized || disconnect ? Color.WHITE : ink);
        button.setBackground(touch(fill, emphasized || disconnect ? 0 : border, 13));
    }

    private GradientDrawable shape(int fill, int stroke, int radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(radius));
        if (stroke != 0) shape.setStroke(dp(1), stroke);
        return shape;
    }

    private RippleDrawable touch(int fill, int stroke, int radius) {
        return new RippleDrawable(ColorStateList.valueOf(color(0x000000, 0xffffff) & 0x00ffffff | 0x20000000),
            shape(fill, stroke, radius), null);
    }

    private int color(int light, int night) {
        return 0xff000000 | (dark ? night : light);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void add(LinearLayout parent, View child, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(top);
        parent.addView(child, params);
    }

    private EditText field(LinearLayout form, String hint, int inputType) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setInputType(inputType);
        field.setSaveEnabled(false);
        field.setTextColor(ink);
        field.setHintTextColor(muted);
        field.setTextSize(15);
        field.setPadding(dp(12), dp(11), dp(12), dp(11));
        field.setBackground(shape(background, border, 12));
        add(form, field, 10);
        return field;
    }

    private boolean active(String message) {
        return message.startsWith("正在") || message.startsWith("已连接") || message.equals("公网代理已启动");
    }

    private void disconnect() {
        startService(new Intent(this, CompanyVpnService.class).setAction(CompanyVpnService.DISCONNECT));
    }

    private void updateNodeSummary() {
        if (selectedLink.isEmpty()) {
            nodeTitle.setText("尚未选择节点  ›");
            nodeDetail.setText("前往节点页导入分享链接");
            nodeSelection.setText("尚未选择节点");
        } else {
            Uri node = Uri.parse(selectedLink);
            String name = TextUtils.isEmpty(node.getFragment()) ? node.getHost() : node.getFragment();
            nodeTitle.setText(name);
            nodeDetail.setText("VLESS · " + node.getHost() + (node.getPort() > 0 ? ":" + node.getPort() : ""));
            nodeSelection.setText(name);
        }
    }

    private void renderStatus(String message) {
        status.setText(message);
        companyStatus.setText(message);
        boolean connecting = message.startsWith("正在");
        boolean running = active(message);
        statusDot.setTextColor(connecting ? color(0xb45309, 0xfbbf24)
            : running ? color(0x047857, 0x34d399) : muted);
        powerIcon.setImageTintList(ColorStateList.valueOf(connecting ? color(0xb45309, 0xfbbf24)
            : running ? color(0x047857, 0x34d399) : blue));
        powerIcon.setBackground(shape(connecting ? color(0xfffbeb, 0x38290e)
            : running ? color(0xecfdf5, 0x10352f) : blueTint, border, 36));
        boolean disconnecting = CompanyVpnService.DISCONNECTING.equals(message);
        primary.setText(disconnecting ? "正在断开…" : connecting ? "取消连接" : running ? "断开当前连接"
            : selectedLink.isEmpty() ? "添加代理节点" : "立即连接代理");
        primary.setEnabled(!disconnecting);
        styleAction(primary, true, running);
        companyConnect.setVisibility(running ? View.GONE : View.VISIBLE);
        companyConnect.setEnabled(!running);
        companyDisconnect.setVisibility(running ? View.VISIBLE : View.GONE);
        companyDisconnect.setEnabled(!disconnecting);
        companyDisconnect.setText(disconnecting ? "正在断开…" : "断开当前连接");
    }

    private void showMessage(String message) {
        if (currentPage == 2) companyStatus.setText(message);
        else status.setText(message);
    }

    private void prepareConnection() {
        int gatewayPort;
        try {
            gatewayPort = Integer.parseInt(port.getText().toString());
            if (gatewayPort < 1 || gatewayPort > 65535) throw new NumberFormatException();
        } catch (NumberFormatException error) {
            showMessage("请输入有效的网关端口");
            return;
        }
        String gateway = host.getText().toString().trim();
        String virtualHub = hub.getText().toString().trim();
        String account = username.getText().toString().trim();
        if (gateway.isEmpty() || virtualHub.isEmpty() || account.isEmpty() || password.length() == 0) {
            showMessage("请填写网关、HUB、账号和密码");
            return;
        }
        String companyRoutes;
        try {
            companyRoutes = Mobile.normalizeRoutes(routes.getText().toString());
        } catch (Exception error) {
            showMessage("请输入有效的公司私网 IPv4 网段");
            return;
        }
        Intent connection = new Intent(this, CompanyVpnService.class).setAction(CompanyVpnService.CONNECT)
            .putExtra("host", gateway).putExtra("port", gatewayPort).putExtra("hub", virtualHub)
            .putExtra("username", account).putExtra("password", password.getText().toString())
            .putExtra("routes", companyRoutes).putExtra("ca", ca.getText().toString().trim())
            .putExtra("suffixes", suffixes.getText().toString().trim());
        password.setText("");
        requestConnection(connection);
    }

    private void requestConnection(Intent connection) {
        String state = CompanyVpnService.currentStatus;
        if (active(state)) {
            showMessage("请先断开当前连接，再切换模式");
            return;
        }
        pending = connection;
        Intent permission = VpnService.prepare(this);
        if (permission == null) startConnection();
        else startActivityForResult(permission, VPN_PERMISSION);
    }

    private void startConnection() {
        if (pending == null) return;
        startForegroundService(pending);
        pending = null;
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != VPN_PERMISSION) return;
        if (result == RESULT_OK) startConnection();
        else {
            pending = null;
            showMessage("需要授权 Android VPN 接入");
        }
    }

    @Override protected void onStart() {
        super.onStart();
        CompanyVpnService.statusListener = statusListener;
        renderStatus(CompanyVpnService.currentStatus);
    }

    @Override protected void onStop() {
        if (CompanyVpnService.statusListener == statusListener) CompanyVpnService.statusListener = null;
        super.onStop();
    }
}
