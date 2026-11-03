package proxymobile

import "github.com/sagernet/sing-box/experimental/libbox"

type Platform interface {
	OpenProxyTun() (int32, error)
	ProtectProxySocket(fd int32) bool
}

type Proxy struct {
	instance *libbox.BlueWingProxy
}

func NewProxy() *Proxy { return &Proxy{instance: libbox.NewBlueWingProxy()} }

func (p *Proxy) Start(profile, resolvers string, platform Platform) error {
	return p.instance.Start(profile, resolvers, platform)
}

func (p *Proxy) Close() { p.instance.Close() }
