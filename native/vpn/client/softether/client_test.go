package softether

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/netip"
	"strconv"
	"testing"
	"time"

	protocol "github.com/mythologyli/zju-connect/client/softether/internal"
)

func testGateway(t *testing.T, stall bool, lifetime ...uint32) Config {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "vpn.test"}, DNSNames: []string{"vpn.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	pair, _ := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	roots := x509.NewCertPool()
	cert, _ := x509.ParseCertificate(der)
	roots.AddCert(cert)
	listener, err := tls.Listen("tcp4", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{pair}})
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	t.Cleanup(func() { close(closed); listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
		r := bufio.NewReader(conn)
		if protocol.ReadSignatureRequest(r) != nil {
			return
		}
		if stall {
			<-closed
			return
		}
		hello := protocol.NewPack()
		hello.AddString("hello", "SoftEther VPN Server")
		hello.AddData("random", bytes.Repeat([]byte{7}, 20))
		if protocol.WritePackResponse(conn, hello) != nil {
			return
		}
		login, err := protocol.ReadPackRequest(r)
		if err != nil {
			return
		}
		welcome := protocol.NewPack()
		if login.GetString("hubname") != "VPN" {
			welcome.AddInt("error", 8)
			_ = protocol.WritePackResponse(conn, welcome)
			return
		}
		expected := protocol.PasswordResponse("tester", "test-password", bytes.Repeat([]byte{7}, 20))
		if !bytes.Equal(login.GetData("secure_password"), expected[:]) {
			welcome.AddInt("error", 9)
			_ = protocol.WritePackResponse(conn, welcome)
			return
		}
		welcome.AddString("session_name", "fixture-session")
		welcome.AddString("connection_name", "fixture-connection")
		welcome.AddData("session_key", make([]byte, 20))
		welcome.AddBool("use_encrypt", true)
		protocol.AddPolicy(welcome, protocol.Policy{Access: true})
		if protocol.WritePackResponse(conn, welcome) != nil {
			return
		}
		stream := protocol.NewFrameStream(r, conn)
		mac := [6]byte{2, 1, 2, 3, 4, 5}
		serverIP := netip.MustParseAddr("10.42.0.1")
		ip := netip.MustParseAddr("10.42.0.2")
		for {
			frames, err := stream.ReadFrames()
			if err != nil {
				return
			}
			for _, frame := range frames {
				if reply, _, _, ok := protocol.DHCPServerReply(frame, mac, serverIP, ip, 24, []netip.Addr{serverIP}); ok {
					if len(lifetime) > 0 {
						for i := 42 + 240; i+1 < len(reply); {
							code, n := reply[i], int(reply[i+1])
							if code == 255 {
								break
							}
							if code == 51 && n == 4 && i+6 <= len(reply) {
								binary.BigEndian.PutUint32(reply[i+2:i+6], lifetime[0])
								break
							}
							i += 2 + n
						}
					}
					if stream.WriteFrames(reply) != nil {
						return
					}
					continue
				}
				if reply, ok := protocol.ARPReply(frame, mac, serverIP); ok {
					if stream.WriteFrames(reply) != nil {
						return
					}
					continue
				}
				if payload, ok := protocol.UnwrapIP(frame); ok && len(payload) >= 20 {
					copy(payload[12:16], serverIP.AsSlice())
					copy(payload[16:20], ip.AsSlice())
					var remote [6]byte
					copy(remote[:], frame[6:12])
					if stream.WriteFrames(protocol.WrapIPv4(payload, mac, remote)) != nil {
						return
					}
				}
			}
		}
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	n, _ := strconv.Atoi(port)
	return Config{Server: host, Port: n, Hub: "VPN", Username: "tester", Password: "test-password", TLS: &tls.Config{RootCAs: roots, ServerName: "vpn.test"}}
}

func TestNativePasswordDHCPARPAndL3(t *testing.T) {
	config := testGateway(t, false)
	bound := false
	dialer := net.Dialer{}
	config.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		bound = true
		return dialer.DialContext(ctx, network, address)
	}
	c := NewClient(config)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer c.Close()
	if err := c.Setup(ctx); err != nil {
		t.Fatal(err)
	}
	if !bound || c.Config.Password != "" {
		t.Fatal("underlay binding or secret cleanup failed")
	}
	ip, _ := c.IP()
	if ip.String() != "10.42.0.2" {
		t.Fatal("DHCP address not applied")
	}
	dns, _ := c.DNSServers()
	if len(dns) != 1 || dns[0] != "10.42.0.1" {
		t.Fatal("DHCP DNS not exposed")
	}
	l3, err := c.NewL3Conn()
	if err != nil {
		t.Fatal(err)
	}
	packet := make([]byte, 28)
	packet[0] = 0x45
	packet[9] = 17
	copy(packet[12:16], ip.To4())
	copy(packet[16:20], net.ParseIP("10.42.0.1").To4())
	if _, err = l3.Write(packet); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { b := make([]byte, 1500); _, err := l3.Read(b); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ARP/L3 response timeout")
	}
	cancel()
	_, err = l3.Read(make([]byte, 1500))
	if err == nil {
		t.Fatal("cancellation did not close tunnel")
	}
	c.Close()
}
func TestAuthenticationFailures(t *testing.T) {
	for _, wrong := range []string{"password", "hub"} {
		t.Run(wrong, func(t *testing.T) {
			cfg := testGateway(t, false)
			if wrong == "password" {
				cfg.Password = "wrong"
			} else {
				cfg.Hub = "missing"
			}
			c := NewClient(cfg)
			defer c.Close()
			if c.Setup(context.Background()) == nil {
				t.Fatal("invalid login accepted")
			}
		})
	}
}
func TestSetupCancellationClosesPendingRead(t *testing.T) {
	c := NewClient(testGateway(t, true))
	defer c.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Setup(ctx) }()
	time.Sleep(30 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled setup succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation blocked")
	}
}
func TestCertificateRejectedBeforeLogin(t *testing.T) {
	cfg := testGateway(t, false)
	cfg.TLS = cfg.TLS.Clone()
	cfg.TLS.ServerName = "wrong.test"
	c := NewClient(cfg)
	defer c.Close()
	if c.Setup(context.Background()) == nil {
		t.Fatal("wrong certificate name accepted")
	}
}
func TestPacketQueueClosesBlockedWriter(t *testing.T) {
	a, b := net.Pipe()
	defer b.Close()
	p := newPacketConn(a, nil, [6]byte{}, protocol.DHCPLease{})
	packet := make([]byte, 20)
	packet[0] = 0x45
	for i := 0; i < cap(p.out); i++ {
		if _, err := p.Write(packet); err != nil {
			t.Fatal(err)
		}
	}
	done := make(chan error, 1)
	go func() { _, err := p.Write(packet); done <- err }()
	p.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("closed writer succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("writer remained blocked")
	}
	if _, err := p.Read(make([]byte, 1500)); err != net.ErrClosed {
		t.Fatal("reader remained open")
	}
	var _ io.ReadWriteCloser = p
}

func TestShortDHCPLeaseRenewsWithoutDroppingSession(t *testing.T) {
	c := NewClient(testGateway(t, false, 4))
	defer c.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := c.Setup(ctx); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	time.Sleep(2500 * time.Millisecond)
	c.l3.mu.Lock()
	renewed := c.l3.renewed
	c.l3.mu.Unlock()
	if !renewed.After(started) {
		t.Fatal("short DHCP lease was not renewed")
	}
	select {
	case <-c.l3.done:
		t.Fatal("renewal closed healthy session")
	default:
	}
}
