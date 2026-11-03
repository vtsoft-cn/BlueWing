package libbox

import (
	"context"
	"errors"
	"sync"
	"syscall"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/option"
	tun "github.com/sagernet/sing-tun"
	"github.com/sagernet/sing/common/logger"
	"github.com/sagernet/sing/service"
)

type BlueWingAndroidPlatform interface {
	OpenProxyTun() (int32, error)
	ProtectProxySocket(fd int32) bool
}

type blueWingPlatform struct {
	platformInterfaceStub
	android BlueWingAndroidPlatform
}

type blueWingMonitor struct{ interfaceMonitorStub }

func (*blueWingMonitor) Start() error { return nil }
func (*blueWingMonitor) Close() error { return nil }

func (*blueWingPlatform) CreateDefaultInterfaceMonitor(logger.Logger) tun.DefaultInterfaceMonitor {
	return &blueWingMonitor{}
}

func (*blueWingPlatform) UsePlatformInterface() bool { return true }

func (p *blueWingPlatform) AutoDetectInterfaceControl(fd int) error {
	if !p.android.ProtectProxySocket(int32(fd)) {
		return errors.New("Android refused to protect the outbound socket")
	}
	return nil
}

func (p *blueWingPlatform) OpenInterface(options *tun.Options, _ option.TunPlatformOptions) (tun.Tun, error) {
	fd, err := p.android.OpenProxyTun()
	if err != nil {
		return nil, err
	}
	options.Name, err = getTunnelName(fd)
	if err != nil {
		_ = syscall.Close(int(fd))
		return nil, err
	}
	options.FileDescriptor = int(fd)
	device, err := tun.New(*options)
	if err != nil {
		_ = syscall.Close(int(fd))
	}
	return device, err
}

type BlueWingProxy struct {
	mu       sync.Mutex
	instance *box.Box
	cancel   context.CancelFunc
	closed   bool
}

func NewBlueWingProxy() *BlueWingProxy { return &BlueWingProxy{} }

func (p *BlueWingProxy) Start(profile, resolvers string, android BlueWingAndroidPlatform) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.instance != nil || android == nil {
		return errors.New("proxy session unavailable")
	}
	config, err := blueWingProxyConfig(profile, resolvers)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(baseContext(nil))
	options, err := parseConfig(ctx, config)
	if err != nil {
		cancel()
		return err
	}
	ctx = service.ContextWith[adapter.PlatformInterface](ctx, &blueWingPlatform{android: android})
	instance, err := box.New(box.Options{Context: ctx, Options: options})
	if err != nil {
		cancel()
		return err
	}
	if err = instance.Start(); err != nil {
		cancel()
		_ = instance.Close()
		return err
	}
	p.instance, p.cancel = instance, cancel
	return nil
}

func (p *BlueWingProxy) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	if p.instance != nil {
		p.cancel()
		_ = p.instance.Close()
		p.instance = nil
	}
}
