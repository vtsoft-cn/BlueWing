// BlueWing userspace adapter. Wire helpers are MIT; see LICENSE-MIT and UPSTREAM.md.
package softether

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/mythologyli/zju-connect/client"
	protocol "github.com/mythologyli/zju-connect/client/softether/internal"
	"inet.af/netaddr"
)

type AuthType uint32

const (
	AuthPassword AuthType = iota
	AuthPlainPassword
	AuthAnonymous
	AuthCertificate
)

type Config struct {
	Server, Hub, Username, Password                                 string
	Port                                                            int
	AuthType                                                        AuthType
	ClientCert, ClientKey                                           []byte
	MaxConnections                                                  int
	DisableEncryption, EnableCompression, HalfConnection, EnableQoS bool
	TLS                                                             *tls.Config
	DialContext                                                     client.DialContextFunc
}
type Client struct {
	Config Config
	mu     sync.Mutex
	l3     *packetConn
	lease  protocol.DHCPLease
	closed bool
}

func NewClient(config Config) *Client { return &Client{Config: config} }

func (c *Client) Setup(ctx context.Context) error {
	if c.Config.Server == "" || c.Config.Hub == "" || c.Config.Username == "" {
		return errors.New("SOFTETHER_CONFIG_REQUIRED")
	}
	if c.Config.AuthType != AuthPassword && c.Config.AuthType != AuthPlainPassword {
		return errors.New("AUTH_METHOD_UNSUPPORTED")
	}
	if c.Config.TLS == nil || c.Config.DisableEncryption {
		return errors.New("TLS_UNTRUSTED")
	}
	dial := c.Config.DialContext
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	setupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	address := net.JoinHostPort(c.Config.Server, strconv.Itoa(c.Config.Port))
	raw, err := dial(setupCtx, "tcp", address)
	if err != nil {
		return fmt.Errorf("softether dial: %w", err)
	}
	stopSetup := context.AfterFunc(setupCtx, func() { _ = raw.Close() })
	success := false
	defer func() {
		stopSetup()
		c.Config.Password = ""
		if !success {
			_ = raw.Close()
		}
	}()
	deadline, _ := setupCtx.Deadline()
	_ = raw.SetDeadline(deadline)
	conn := tls.Client(idleTimeoutConn{Conn: raw}, c.Config.TLS.Clone())
	if err = conn.HandshakeContext(setupCtx); err != nil {
		return err
	}
	reader := bufio.NewReaderSize(conn, 64*1024)
	parameters, err := clientHandshake(c.Config, conn, reader, address)
	if err != nil {
		return err
	}
	if !parameters.UseEncrypt || parameters.HalfConnection {
		return errors.New("SOFTETHER_TRANSPORT_UNSUPPORTED")
	}
	stream := protocol.NewFrameStream(reader, conn, parameters.UseCompress)
	var mac [6]byte
	if _, err = rand.Read(mac[:]); err != nil {
		return err
	}
	mac[0] = mac[0]&0xfe | 0x02
	lease, err := protocol.AcquireDHCP(stream, mac)
	if err != nil {
		return fmt.Errorf("SOFTETHER_DHCP_FAILED: %w", err)
	}
	if lease.Address.Bits() == 0 || !lease.Address.Addr().Is4() || lease.Address.Addr().IsUnspecified() {
		return errors.New("SOFTETHER_DHCP_FAILED")
	}
	if err = conn.SetDeadline(time.Time{}); err != nil {
		return err
	}
	p := newPacketConn(conn, stream, mac, lease)
	c.mu.Lock()
	if c.closed || ctx.Err() != nil {
		c.mu.Unlock()
		_ = p.Close()
		return context.Canceled
	}
	c.l3, c.lease = p, lease
	c.mu.Unlock()
	// The parent session, rather than the short setup deadline, owns the tunnel.
	if !stopSetup() && setupCtx.Err() != nil {
		_ = p.Close()
		return setupCtx.Err()
	}
	p.stopContext = context.AfterFunc(ctx, func() { _ = p.Close() })
	success = true
	go p.run()
	return nil
}
func (c *Client) Close() {
	c.mu.Lock()
	c.closed = true
	p := c.l3
	c.mu.Unlock()
	if p != nil {
		_ = p.Close()
	}
}
func (c *Client) IP() (net.IP, error) { return net.IP(c.lease.Address.Addr().AsSlice()), nil }
func (c *Client) IPSet() (*netaddr.IPSet, error) {
	var b netaddr.IPSetBuilder
	for _, p := range c.prefixes() {
		b.AddPrefix(netaddr.MustParseIPPrefix(p.String()))
	}
	return b.IPSet()
}
func (c *Client) prefixes() []netip.Prefix {
	prefixes := []netip.Prefix{c.lease.Address.Masked()}
	for _, r := range c.lease.Routes {
		if r.Bits() > 0 {
			prefixes = append(prefixes, r.Masked())
		}
	}
	return prefixes
}
func (c *Client) IPResources() ([]client.IPResource, error) {
	var result []client.IPResource
	for _, prefix := range c.prefixes() {
		p := netaddr.MustParseIPPrefix(prefix.String()).Range()
		result = append(result, client.IPResource{IPMin: net.ParseIP(p.From().String()), IPMax: net.ParseIP(p.To().String()), PortMin: 1, PortMax: 65535, Protocol: "all"})
	}
	return result, nil
}
func (c *Client) DomainResources() (client.DomainResources, error) {
	return client.DomainResources{}, nil
}
func (c *Client) DNSResource() (map[string][]net.IP, error) { return map[string][]net.IP{}, nil }
func (c *Client) DNSServer() (string, error) {
	s, _ := c.DNSServers()
	if len(s) > 0 {
		return s[0], nil
	}
	return "", nil
}
func (c *Client) DNSServers() ([]string, error) {
	s := []string{}
	for _, ip := range c.lease.DNS {
		if ip.Is4() && !ip.IsUnspecified() {
			s = append(s, ip.String())
		}
	}
	return s, nil
}
func (c *Client) CanUseTCPTunnel() bool { return false }
func (c *Client) DialTCP(context.Context, *net.TCPAddr) (net.Conn, error) {
	return nil, errors.New("TCP uses private stack")
}
func (c *Client) NewL3Conn() (io.ReadWriteCloser, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.l3 == nil || c.closed {
		return nil, net.ErrClosed
	}
	return c.l3, nil
}

var _ client.Client = (*Client)(nil)
