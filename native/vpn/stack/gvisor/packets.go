package gvisor

import (
	"errors"
	"net/netip"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

const packetNIC tcpip.NICID = 2

// packetLink is entirely in memory. gVisor handles IPv4 routing, fragmentation,
// connection tracking and reverse NAT; no Windows adapter or route is installed.
type packetLink struct {
	*Endpoint
	returnPacket func([]byte)
}

func (p *packetLink) WritePackets(list stack.PacketBufferList) (int, tcpip.Error) {
	for _, packet := range list.AsSlice() {
		p.returnPacket(joinPacketSlices(packet.AsSlices()))
	}
	return list.Len(), nil
}

func (s *Stack) EnablePackets(returnPacket func([]byte)) error {
	s.bridgeMu.Lock()
	defer s.bridgeMu.Unlock()
	if s.bridgeClosed || s.packets != nil {
		return errors.New("packet bridge unavailable")
	}
	ep := &packetLink{Endpoint: &Endpoint{}, returnPacket: returnPacket}
	if err := s.gvisorStack.CreateNICWithOptions(packetNIC, ep, stack.NICOptions{Name: "bluewing-packets"}); err != nil {
		return errors.New(err.String())
	}
	if err := s.gvisorStack.SetForwardingDefaultAndAllNICs(header.IPv4ProtocolNumber, true); err != nil {
		return errors.New(err.String())
	}
	// Only packets leaving the provider link are masqueraded. This also lets
	// ordinary SOCKS/DNS sockets coexist safely with forwarded TCP/UDP flows.
	tables := s.gvisorStack.IPTables()
	nat := tables.GetTable(stack.NATID, false)
	index := nat.BuiltinChains[stack.Postrouting]
	filter := stack.EmptyFilter4()
	filter.OutputInterface = "bluewing-vpn"
	// Interface masks use 0xff for an exact character match.
	mask := make([]byte, len(filter.OutputInterface))
	for i := range mask {
		mask[i] = 0xff
	}
	filter.OutputInterfaceMask = string(mask)
	rules := append([]stack.Rule(nil), nat.Rules[:index]...)
	rules = append(rules, stack.Rule{Filter: filter, Target: &stack.MasqueradeTarget{NetworkProtocol: header.IPv4ProtocolNumber}})
	nat.Rules = append(rules, nat.Rules[index:]...)
	for hook := range nat.BuiltinChains {
		if nat.BuiltinChains[hook] >= index && stack.Hook(hook) != stack.Postrouting {
			nat.BuiltinChains[hook]++
		}
		if nat.Underflows[hook] >= index {
			nat.Underflows[hook]++
		}
	}
	tables.ReplaceTable(stack.NATID, nat, false)
	s.packets, s.sources = ep, make(map[tcpip.Address]bool)
	return nil
}

func (s *Stack) InjectPacket(packet []byte) error {
	if len(packet) < header.IPv4MinimumSize || packet[0]>>4 != 4 {
		return errors.New("invalid IPv4 packet")
	}
	source := netip.AddrFrom4([4]byte(packet[12:16]))
	if !source.IsGlobalUnicast() || source.IsLoopback() || source.IsLinkLocalUnicast() {
		return errors.New("invalid packet source")
	}
	s.bridgeMu.Lock()
	defer s.bridgeMu.Unlock()
	if s.bridgeClosed || s.packets == nil {
		return errors.New("packet bridge closed")
	}
	address := tcpip.AddrFrom4(source.As4())
	if address == s.ip {
		return errors.New("packet source conflicts with VPN address")
	}
	if !s.sources[address] {
		if len(s.sources) >= 128 {
			return errors.New("packet source limit")
		}
		subnet, err := tcpip.NewSubnet(address, tcpip.MaskFromBytes([]byte{255, 255, 255, 255}))
		if err != nil {
			return err
		}
		s.gvisorStack.AddRoute(tcpip.Route{Destination: subnet, NIC: packetNIC})
		s.sources[address] = true
	}
	buffer := makeInboundPacketBuffer(packet, len(packet))
	s.packets.dispatcher.DeliverNetworkPacket(header.IPv4ProtocolNumber, buffer)
	buffer.DecRef()
	return nil
}
