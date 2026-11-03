package ipv4frag

import (
	"bytes"
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func fragmentFixture(id uint16, payload []byte, offset int, more bool) []byte {
	b := make([]byte, 20+len(payload))
	b[0] = 0x45
	b[8] = 64
	b[9] = 17
	binary.BigEndian.PutUint16(b[2:4], uint16(len(b)))
	binary.BigEndian.PutUint16(b[4:6], id)
	flags := uint16(offset / 8)
	if more {
		flags |= 0x2000
	}
	binary.BigEndian.PutUint16(b[6:8], flags)
	copy(b[12:16], net.IPv4(100, 127, 255, 1).To4())
	copy(b[16:20], net.IPv4(10, 88, 0, 53).To4())
	copy(b[20:], payload)
	binary.BigEndian.PutUint16(b[10:12], ipv4Checksum(b[:20]))
	return b
}
func udpFragmentFixture(port uint16) ([]byte, []byte, []byte) {
	payload := make([]byte, 2008)
	for i := 8; i < len(payload); i++ {
		payload[i] = byte(i)
	}
	binary.BigEndian.PutUint16(payload[0:2], 45000)
	binary.BigEndian.PutUint16(payload[2:4], port)
	binary.BigEndian.PutUint16(payload[4:6], uint16(len(payload)))
	return fragmentFixture(71, payload[:1248], 0, true), fragmentFixture(71, payload[1248:], 1248, false), payload
}
func TestFragmentOverlapDuplicatesExpiryAndBounds(t *testing.T) {
	first, last, payload := udpFragmentFixture(53)
	now := time.Now()
	var f Reassembler
	if f.Accept(first, now) != nil || f.Accept(first, now) != nil {
		t.Fatal("duplicate first fragment escaped")
	}
	if got := f.Accept(last, now); got == nil || !bytes.Equal(got[20:], payload) {
		t.Fatal("exact duplicates broke reassembly")
	}
	f = Reassembler{}
	f.Accept(first, now)
	overlap := fragmentFixture(71, payload[8:], 8, false)
	if f.Accept(overlap, now) != nil || f.Accept(last, now) != nil {
		t.Fatal("overlapping datagram was accepted")
	}
	if got := f.Accept(first, now.Add(fragmentLifetime+time.Second)); got != nil {
		t.Fatal("expired fragments were reused")
	}
	if got := f.Accept(last, now.Add(fragmentLifetime+time.Second)); got == nil {
		t.Fatal("expired quarantine did not release capacity")
	}
	f = Reassembler{}
	for i := 0; i < maxFragmentDatagrams+8; i++ {
		f.Accept(fragmentFixture(uint16(i), payload[:1248], 0, true), now)
	}
	if len(f.entries) != maxFragmentDatagrams || f.bytes > maxFragmentBytes {
		t.Fatal("fragment bounds exceeded")
	}
	f.Accept(fragmentFixture(999, payload[:1248], 0, true), now.Add(fragmentLifetime+time.Second))
	if len(f.entries) != 1 {
		t.Fatal("expired fragments did not release memory")
	}
}
func TestFragmentInvalidHeadersAndSessionsAreIsolated(t *testing.T) {
	first, last, _ := udpFragmentFixture(53)
	now := time.Now()
	var a, b Reassembler
	if a.Accept(first, now) != nil || b.Accept(last, now) != nil {
		t.Fatal("fragments crossed sessions")
	}
	malformed := append([]byte(nil), first...)
	malformed[10] ^= 1
	var f Reassembler
	if f.Accept(malformed, now) != nil || len(f.entries) != 0 {
		t.Fatal("invalid checksum allocated fragment state")
	}
	malformed = fragmentFixture(1, []byte{1, 2, 3}, 0, true)
	if f.Accept(malformed, now) != nil || len(f.entries) != 0 {
		t.Fatal("non-aligned fragment accepted")
	}
}
