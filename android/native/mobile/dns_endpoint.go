package mobile

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/netip"
	"time"

	"github.com/miekg/dns"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

const virtualDNS = "198.18.0.53"

type dnsEndpoint struct {
	link  *channel.Endpoint
	stack *stack.Stack
	udp   *gonet.UDPConn
	tcp   *gonet.TCPListener
}

func newDNSEndpoint() (*dnsEndpoint, error) {
	e := &dnsEndpoint{
		link: channel.New(128, 1400, ""),
		stack: stack.New(stack.Options{
			NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
			TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol},
		}),
	}
	ok := false
	defer func() {
		if !ok {
			e.close()
		}
	}()
	const nic = 1
	if err := e.stack.CreateNIC(nic, e.link); err != nil {
		return nil, fmt.Errorf("create DNS interface: %s", err)
	}
	address := tcpip.AddrFrom4(netip.MustParseAddr(virtualDNS).As4())
	if err := e.stack.AddProtocolAddress(nic, tcpip.ProtocolAddress{
		Protocol: ipv4.ProtocolNumber, AddressWithPrefix: address.WithPrefix(),
	}, stack.AddressProperties{}); err != nil {
		return nil, fmt.Errorf("assign DNS interface: %s", err)
	}
	e.stack.AddRoute(tcpip.Route{Destination: header.IPv4EmptySubnet, NIC: nic})
	local := tcpip.FullAddress{NIC: nic, Addr: address, Port: 53}
	var err error
	e.udp, err = gonet.DialUDP(e.stack, &local, nil, ipv4.ProtocolNumber)
	if err != nil {
		return nil, err
	}
	e.tcp, err = gonet.ListenTCP(e.stack, local, ipv4.ProtocolNumber)
	if err != nil {
		return nil, err
	}
	ok = true
	return e, nil
}

func (e *dnsEndpoint) close() {
	if e.udp != nil {
		_ = e.udp.Close()
	}
	if e.tcp != nil {
		_ = e.tcp.Close()
	}
	e.stack.Close()
	e.link.Close()
}

func (e *dnsEndpoint) inject(packet []byte) {
	pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(packet)})
	defer pkt.DecRef()
	e.link.InjectInbound(ipv4.ProtocolNumber, pkt)
}

func (e *dnsEndpoint) writeReplies(ctx context.Context, tun io.Writer) error {
	for {
		packet := e.link.ReadContext(ctx)
		if packet == nil {
			return ctx.Err()
		}
		view := packet.ToView()
		packet.DecRef()
		_, err := tun.Write(view.AsSlice())
		view.Release()
		if err != nil {
			return err
		}
	}
}

func (e *dnsEndpoint) serve(ctx context.Context, resolver splitDNS) {
	handle := dns.HandlerFunc(func(w dns.ResponseWriter, q *dns.Msg) {
		queryCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		defer cancel()
		answer, err := resolver.resolve(queryCtx, q)
		if err != nil {
			answer = new(dns.Msg).SetRcode(q, dns.RcodeServerFailure)
		}
		_ = w.WriteMsg(answer)
	})
	// miekg/dns requires a native *net.UDPConn for its UDP transport.
	// The endpoint is a gVisor PacketConn, so handle datagrams directly.
	go serveDNSDatagrams(ctx, e.udp, resolver)
	go func() {
		server := &dns.Server{Listener: e.tcp, Handler: handle}
		defer server.Shutdown()
		_ = server.ActivateAndServe()
	}()
}

func serveDNSDatagrams(ctx context.Context, conn net.PacketConn, resolver splitDNS) {
	workers := make(chan struct{}, 32)
	buffer := make([]byte, 1400)
	for {
		n, address, err := conn.ReadFrom(buffer)
		if err != nil {
			return
		}
		query := new(dns.Msg)
		if query.Unpack(buffer[:n]) != nil {
			continue
		}
		select {
		case workers <- struct{}{}:
		default:
			continue
		}
		go func() {
			defer func() { <-workers }()
			queryCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
			defer cancel()
			answer, err := resolver.resolve(queryCtx, query)
			if err != nil {
				answer = new(dns.Msg).SetRcode(query, dns.RcodeServerFailure)
			}
			size := dns.MinMsgSize
			if edns := query.IsEdns0(); edns != nil {
				size = max(size, min(int(edns.UDPSize()), 1232))
			}
			answer.Truncate(size)
			if payload, err := answer.Pack(); err == nil {
				_, _ = conn.WriteTo(payload, address)
			}
		}()
	}
}
