package mobile

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"syscall"

	"github.com/mythologyli/zju-connect/client/softether"
)

// SocketProtector keeps the VPN server connection outside the Android tunnel.
type SocketProtector interface {
	Protect(fd int32) bool
}

// Session owns one provider connection and its Android packet interface.
type Session struct {
	ctx           context.Context
	cancel        context.CancelFunc
	mu            sync.Mutex
	client        *softether.Client
	protectedDial dnsDial
}

func NewSession() *Session {
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{ctx: ctx, cancel: cancel}
}

func (s *Session) Connect(host string, port int, hub, user, password, caPEM string, protector SocketProtector) error {
	if protector == nil || port < 1 || port > 65535 {
		return errors.New("a socket protector and valid gateway port are required")
	}
	tlsConfig := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	if caPEM != "" {
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM([]byte(caPEM)) {
			return errors.New("invalid gateway CA certificate")
		}
		tlsConfig.RootCAs = roots
	}
	dialer := &net.Dialer{Control: func(_, _ string, raw syscall.RawConn) error {
		var protected bool
		if err := raw.Control(func(fd uintptr) { protected = protector.Protect(int32(fd)) }); err != nil {
			return err
		}
		if !protected {
			return errors.New("Android refused to protect the VPN gateway socket")
		}
		return nil
	}}
	provider := softether.NewClient(softether.Config{
		Server: host, Port: port, Hub: hub, Username: user, Password: password,
		TLS: tlsConfig, DialContext: dialer.DialContext, MaxConnections: 1,
	})
	s.mu.Lock()
	if s.client != nil || s.ctx.Err() != nil {
		s.mu.Unlock()
		return errors.New("VPN session already started or closed")
	}
	s.client = provider
	s.protectedDial = dialer.DialContext
	s.mu.Unlock()
	if err := provider.Setup(s.ctx); err != nil {
		s.Close()
		return err
	}
	return nil
}

func (s *Session) Address() (string, error) {
	address, err := s.client.IP()
	if err != nil {
		return "", err
	}
	return address.String(), nil
}

func (s *Session) DNS() (string, error) {
	server, err := s.client.DNSServer()
	if err != nil {
		return "", err
	}
	if _, err := NormalizeRoutes(server + "/32"); err != nil {
		return "", errors.New("gateway did not supply a private IPv4 DNS server")
	}
	return server, nil
}

func VirtualDNSAddress() string { return virtualDNS }

// Forward takes ownership of a detached VpnService file descriptor and blocks
// until either side closes. The caller must establish only company routes.
func (s *Session) Forward(fd int32, companySuffixes, publicServers string) error {
	if fd < 0 {
		return errors.New("invalid Android tunnel descriptor")
	}
	if err := syscall.SetNonblock(int(fd), true); err != nil {
		_ = syscall.Close(int(fd))
		return err
	}
	tun := os.NewFile(uintptr(fd), "android-vpn")
	defer tun.Close()
	defer s.Close()
	stop := context.AfterFunc(s.ctx, func() { _ = tun.Close() })
	defer stop()
	tunnel, err := s.client.NewL3Conn()
	if err != nil {
		return err
	}
	suffixes, err := parseDNSSuffixes(companySuffixes)
	if err != nil {
		return err
	}
	var localDNS *dnsEndpoint
	if len(suffixes) > 0 {
		server, err := s.DNS()
		if err != nil {
			return err
		}
		address, err := s.client.IP()
		if err != nil {
			return err
		}
		localDNS, err = newDNSEndpoint()
		if err != nil {
			return err
		}
		defer localDNS.close()
		localDNS.serve(s.ctx, splitDNS{
			suffixes: suffixes, companyServers: []string{server},
			publicServers: strings.Fields(publicServers), publicDial: s.protectedDial,
			companyDial: func(ctx context.Context, network, target string) (net.Conn, error) {
				dialer := &net.Dialer{}
				if network == "udp" {
					dialer.LocalAddr = &net.UDPAddr{IP: address}
				} else {
					dialer.LocalAddr = &net.TCPAddr{IP: address}
				}
				return dialer.DialContext(ctx, network, target)
			},
		})
	}
	done := make(chan error, 3)
	pumps := 2
	if localDNS != nil {
		pumps++
		go func() { done <- localDNS.writeReplies(s.ctx, tun) }()
	}
	virtualAddress := netip.MustParseAddr(virtualDNS).As4()
	copyPackets := func(dst io.Writer, src io.Reader, fromAndroid bool) {
		buffer := make([]byte, 65535)
		for {
			n, err := src.Read(buffer)
			if err != nil {
				done <- err
				return
			}
			if n > 0 {
				if fromAndroid && localDNS != nil && n >= 20 && buffer[0]>>4 == 4 &&
					[4]byte(buffer[16:20]) == virtualAddress {
					localDNS.inject(buffer[:n])
					continue
				}
				written, err := dst.Write(buffer[:n])
				if err != nil {
					done <- err
					return
				}
				if written != n {
					done <- io.ErrShortWrite
					return
				}
			}
		}
	}
	go copyPackets(tunnel, tun, true)
	go copyPackets(tun, tunnel, false)
	err = <-done
	s.Close()
	_ = tun.Close()
	for i := 1; i < pumps; i++ {
		<-done
	}
	return err
}

func (s *Session) Close() {
	s.cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		s.client.Close()
	}
}
