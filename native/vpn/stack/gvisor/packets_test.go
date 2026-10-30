package gvisor

import (
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"github.com/mythologyli/zju-connect/client"
)

type packetPipe struct {
	in, out chan []byte
	done    chan struct{}
}

func (p *packetPipe) Read(b []byte) (int, error) {
	select {
	case b2 := <-p.in:
		return copy(b, b2), nil
	case <-p.done:
		return 0, io.EOF
	}
}
func (p *packetPipe) Write(b []byte) (int, error) {
	p.out <- append([]byte(nil), b...)
	return len(b), nil
}
func (p *packetPipe) Close() error {
	select {
	case <-p.done:
	default:
		close(p.done)
	}
	return nil
}

type packetClient struct {
	client.Client
	pipe *packetPipe
}

func (*packetClient) IP() (net.IP, error)                      { return net.IPv4(192, 168, 30, 99), nil }
func (c *packetClient) NewL3Conn() (io.ReadWriteCloser, error) { return c.pipe, nil }
func checksum(b []byte) uint16 {
	var sum uint32
	for len(b) > 1 {
		sum += uint32(binary.BigEndian.Uint16(b))
		b = b[2:]
	}
	if len(b) > 0 {
		sum += uint32(b[0]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 65535) + (sum >> 16)
	}
	return ^uint16(sum)
}
func ipv4TestPacket(protocol byte) []byte {
	b := make([]byte, 40)
	b[0] = 0x45
	binary.BigEndian.PutUint16(b[2:], uint16(len(b)))
	b[8] = 64
	b[9] = protocol
	copy(b[12:], net.IPv4(172, 19, 0, 1).To4())
	copy(b[16:], net.IPv4(192, 168, 110, 45).To4())
	copy(b[28:], []byte("first-packet"))
	if protocol == 1 {
		b[20] = 8
		binary.BigEndian.PutUint16(b[24:], 1234)
		binary.BigEndian.PutUint16(b[26:], 1)
		binary.BigEndian.PutUint16(b[22:], checksum(b[20:]))
	} else {
		binary.BigEndian.PutUint16(b[20:], 33444)
		binary.BigEndian.PutUint16(b[22:], 12345)
		binary.BigEndian.PutUint16(b[24:], uint16(len(b)-20))
	}
	binary.BigEndian.PutUint16(b[10:], checksum(b[:20]))
	return b
}
func TestPacketBridgeFirstICMPAndUDPRequestUsesVPNAndReverseNAT(t *testing.T) {
	for _, protocol := range []byte{1, 17} {
		t.Run(map[byte]string{1: "icmp", 17: "udp"}[protocol], func(t *testing.T) {
			pipe := &packetPipe{in: make(chan []byte, 16), out: make(chan []byte, 16), done: make(chan struct{})}
			s, err := NewStack(&packetClient{pipe: pipe})
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Prepare(); err != nil {
				t.Fatal(err)
			}
			result := make(chan []byte, 4)
			if err = s.EnablePackets(func(b []byte) { result <- b }); err != nil {
				t.Fatal(err)
			}
			go func() { defer func() { recover() }(); s.Run() }()
			t.Cleanup(s.Close)
			original := ipv4TestPacket(protocol)
			if err = s.InjectPacket(original); err != nil {
				t.Fatal(err)
			}
			var sent []byte
			select {
			case sent = <-pipe.out:
			case <-time.After(time.Second):
				t.Fatalf("first packet not forwarded: %+v", s.gvisorStack.Stats().IP)
			}
			if !net.IP(sent[12:16]).Equal(net.IPv4(192, 168, 30, 99)) {
				t.Fatalf("no source NAT: %v", net.IP(sent[12:16]))
			}
			reply := append([]byte(nil), sent...)
			copy(reply[12:16], sent[16:20])
			copy(reply[16:20], sent[12:16])
			reply[10], reply[11] = 0, 0
			binary.BigEndian.PutUint16(reply[10:], checksum(reply[:20]))
			if protocol == 1 {
				reply[20] = 0
				reply[22], reply[23] = 0, 0
				binary.BigEndian.PutUint16(reply[22:], checksum(reply[20:]))
			} else {
				copy(reply[20:22], sent[22:24])
				copy(reply[22:24], sent[20:22])
				reply[26], reply[27] = 0, 0
			}
			pipe.in <- reply
			select {
			case got := <-result:
				if !net.IP(got[16:20]).Equal(net.IPv4(172, 19, 0, 1)) {
					t.Fatalf("reverse NAT lost original client: %v", net.IP(got[16:20]))
				}
				if protocol == 1 && binary.BigEndian.Uint16(got[24:]) != 1234 {
					t.Fatal("ICMP identifier changed")
				}
				if protocol == 17 && binary.BigEndian.Uint16(got[22:]) != 33444 {
					t.Fatal("UDP port changed")
				}
			case <-time.After(time.Second):
				t.Fatal("first response not delivered")
			}
		})
	}
}
