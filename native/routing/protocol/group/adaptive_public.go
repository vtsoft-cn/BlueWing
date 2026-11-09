package group

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/common/interrupt"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/service"
)

const (
	adaptivePublicType  = "bluewing-adaptive"
	maxAdaptiveHosts    = 256
	firstConnectionWait = 2200 * time.Millisecond
)

func RegisterAdaptivePublic(registry *outbound.Registry) {
	outbound.Register[option.AdaptivePublicOutboundOptions](registry, adaptivePublicType, NewAdaptivePublic)
}

type adaptiveKey struct {
	host  string
	proxy string
}

type adaptiveDecision struct {
	ready   chan struct{}
	expires time.Time
	ip      netip.Addr
}

// AdaptivePublic handles only the public fallback selected by the router. It
// learns on separate, authenticated TLS probes before choosing where to dial.
type AdaptivePublic struct {
	outbound.Adapter
	ctx       context.Context
	cancel    context.CancelFunc
	manager   adapter.OutboundManager
	dns       adapter.DNSRouter
	dnsTags   adapter.DNSTransportManager
	logger    log.ContextLogger
	options   option.AdaptivePublicOutboundOptions
	proxy     adapter.Outbound
	direct    adapter.Outbound
	slots     chan struct{}
	mu        sync.Mutex
	decisions map[adaptiveKey]*adaptiveDecision
}

func NewAdaptivePublic(ctx context.Context, _ adapter.Router, logger log.ContextLogger, tag string, options option.AdaptivePublicOutboundOptions) (adapter.Outbound, error) {
	if options.Proxy == "" || options.Direct == "" || options.Proxy == options.Direct {
		return nil, errors.New("adaptive public routing requires distinct proxy and direct outbounds")
	}
	ctx, cancel := context.WithCancel(ctx)
	return &AdaptivePublic{
		Adapter: outbound.NewAdapter(adaptivePublicType, tag, []string{N.NetworkTCP}, []string{options.Proxy, options.Direct}),
		ctx:     ctx, cancel: cancel, logger: logger, options: options,
		manager: service.FromContext[adapter.OutboundManager](ctx),
		dns:     service.FromContext[adapter.DNSRouter](ctx),
		dnsTags: service.FromContext[adapter.DNSTransportManager](ctx),
		slots:   make(chan struct{}, 4), decisions: make(map[adaptiveKey]*adaptiveDecision),
	}, nil
}

func (a *AdaptivePublic) Start(stage adapter.StartStage, scope *adapter.Scope) error {
	if stage != adapter.StartStateStart {
		return nil
	}
	a.proxy, _ = a.manager.Outbound(a.options.Proxy)
	a.direct, _ = a.manager.Outbound(a.options.Direct)
	if a.proxy == nil || a.direct == nil {
		return errors.New("adaptive public outbound dependencies are unavailable")
	}
	scope.Add(func() error { a.cancel(); return nil })
	return nil
}

func (a *AdaptivePublic) InterfaceUpdated(context.Context) {
	a.mu.Lock()
	clear(a.decisions)
	a.mu.Unlock()
}

func (a *AdaptivePublic) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	ctx = interrupt.ContextWithIsExternalConnection(ctx)
	host := strings.ToLower(strings.TrimSuffix(destination.Fqdn, "."))
	if network != N.NetworkTCP || destination.Port != 443 || !eligiblePublicHost(host) {
		return a.proxy.DialContext(ctx, network, destination)
	}

	probeProxy := a.proxy
	if group, ok := a.proxy.(adapter.OutboundGroup); ok {
		if selected, loaded := a.manager.Outbound(group.Now()); loaded {
			probeProxy = selected
		}
	}
	key := adaptiveKey{host: host, proxy: probeProxy.Tag()}
	entry := a.observe(key, probeProxy)
	ip := a.wait(ctx, key, entry, firstConnectionWait)
	if ip.IsValid() {
		// An IP is used only after a successful TLS probe for the original name.
		// The caller still performs its own TLS handshake with its original SNI.
		dialCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		conn, err := a.direct.DialContext(dialCtx, network, M.Socksaddr{Addr: ip, Port: destination.Port})
		cancel()
		if err == nil {
			return conn, nil
		}
		a.mu.Lock()
		if a.decisions[key] == entry {
			delete(a.decisions, key)
		}
		a.mu.Unlock()
	}

	conn, err := a.proxy.DialContext(ctx, network, destination)
	if err == nil || ip.IsValid() || ctx.Err() != nil {
		return conn, err
	}
	// No user bytes have been sent. A verified alternative can recover a
	// failed dial; a connection that was handed to the relay is never retried.
	if ip = a.wait(ctx, key, entry, adaptiveProbeTimeout); ip.IsValid() {
		return a.direct.DialContext(ctx, network, M.Socksaddr{Addr: ip, Port: destination.Port})
	}
	return nil, err
}

func (a *AdaptivePublic) ListenPacket(ctx context.Context, destination M.Socksaddr) (net.PacketConn, error) {
	return a.proxy.ListenPacket(interrupt.ContextWithIsExternalConnection(ctx), destination)
}

func (a *AdaptivePublic) observe(key adaptiveKey, proxy adapter.Outbound) *adaptiveDecision {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	if entry := a.decisions[key]; entry != nil && (entry.expires.IsZero() || now.Before(entry.expires)) {
		return entry
	}
	for key, entry := range a.decisions {
		if !entry.expires.IsZero() && !now.Before(entry.expires) {
			delete(a.decisions, key)
		}
	}
	if len(a.decisions) >= maxAdaptiveHosts {
		return nil
	}
	select {
	case a.slots <- struct{}{}:
	default:
		return nil
	}

	entry := &adaptiveDecision{ready: make(chan struct{})}
	a.decisions[key] = entry
	go func() {
		defer func() { <-a.slots }()
		ctx, cancel := context.WithTimeout(a.ctx, adaptiveProbeTimeout)
		defer cancel()
		ip := a.compare(ctx, key.host, proxy)
		ttl := 45 * time.Second
		if ip.IsValid() {
			ttl = 2 * time.Minute
		}
		a.mu.Lock()
		entry.ip = ip
		entry.expires = time.Now().Add(ttl)
		current := a.decisions[key] == entry
		close(entry.ready)
		a.mu.Unlock()
		if current && ip.IsValid() && a.ctx.Err() == nil {
			a.logger.Info("adaptive public route: ", key.host, " -> direct ", ip)
		}
	}()
	return entry
}

func (a *AdaptivePublic) wait(ctx context.Context, key adaptiveKey, entry *adaptiveDecision, limit time.Duration) netip.Addr {
	if entry == nil {
		return netip.Addr{}
	}
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case <-entry.ready:
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.decisions[key] == entry {
			return entry.ip
		}
	case <-ctx.Done():
	case <-timer.C:
	}
	return netip.Addr{}
}
