// Package ipv4frag reassembles bounded IPv4 datagrams before authorization or NAT.
package ipv4frag

import (
	"bytes"
	"encoding/binary"
	"sort"
	"sync"
	"time"
)

const maxFragmentDatagrams = 64
const maxFragmentBytes = 4 << 20
const fragmentLifetime = 15 * time.Second

type fragmentKey struct {
	source, destination [4]byte
	id                  uint16
	protocol            byte
}
type fragmentPart struct {
	offset int
	data   []byte
	more   bool
}
type fragmentEntry struct {
	header      []byte
	parts       []fragmentPart
	total, size int
	expires     time.Time
	invalid     bool
}

// Reassembler owns fragment state for one tunnel and one traffic direction.
type Reassembler struct {
	mu      sync.Mutex
	entries map[fragmentKey]*fragmentEntry
	bytes   int
}

func ipv4Checksum(b []byte) uint16 {
	var sum uint32
	for len(b) >= 2 {
		sum += uint32(binary.BigEndian.Uint16(b))
		b = b[2:]
	}
	if len(b) != 0 {
		sum += uint32(b[0]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 65535) + (sum >> 16)
	}
	return ^uint16(sum)
}

// Accept returns a complete datagram, or nil until all valid fragments arrive.
// Overlap, memory and time limits also apply to out-of-order fragments.
func (f *Reassembler) Accept(packet []byte, now time.Time) []byte {
	if len(packet) < 20 || packet[0]>>4 != 4 {
		return nil
	}
	hlen, length := int(packet[0]&15)*4, int(binary.BigEndian.Uint16(packet[2:4]))
	if hlen < 20 || length < hlen || length > len(packet) {
		return nil
	}
	packet = packet[:length]
	flags := binary.BigEndian.Uint16(packet[6:8])
	if flags&0x8000 != 0 {
		return nil
	}
	if flags&0x3fff == 0 {
		return packet
	}
	if flags&0x4000 != 0 || ipv4Checksum(packet[:hlen]) != 0 {
		return nil
	}
	offset, payload := int(flags&0x1fff)*8, packet[hlen:]
	more := flags&0x2000 != 0
	if len(payload) == 0 || (more && len(payload)%8 != 0) || offset+len(payload) > 65535-20 {
		return nil
	}
	key := fragmentKey{[4]byte(packet[12:16]), [4]byte(packet[16:20]), binary.BigEndian.Uint16(packet[4:6]), packet[9]}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.entries == nil {
		f.entries = make(map[fragmentKey]*fragmentEntry)
	}
	for k, e := range f.entries {
		if !now.Before(e.expires) {
			f.bytes -= e.size
			delete(f.entries, k)
		}
	}
	e := f.entries[key]
	if e == nil {
		if len(f.entries) >= maxFragmentDatagrams || f.bytes+len(payload) > maxFragmentBytes {
			return nil
		}
		e = &fragmentEntry{total: -1, expires: now.Add(fragmentLifetime)}
		f.entries[key] = e
	}
	if e.invalid {
		return nil
	}
	invalidate := func() []byte {
		f.bytes -= e.size
		e.size = 0
		e.parts = nil
		e.header = nil
		e.invalid = true
		return nil
	}
	end := offset + len(payload)
	if e.total >= 0 && (end > e.total || (more && end >= e.total)) {
		return invalidate()
	}
	if !more {
		if e.total >= 0 && e.total != end {
			return invalidate()
		}
		for _, part := range e.parts {
			if part.offset+len(part.data) > end {
				return invalidate()
			}
		}
		e.total = end
	}
	for _, part := range e.parts {
		if part.offset == offset && bytes.Equal(part.data, payload) {
			if part.more != more {
				return invalidate()
			}
			return nil
		}
		if offset < part.offset+len(part.data) && part.offset < end {
			return invalidate()
		}
	}
	if len(e.parts) >= 128 || f.bytes+len(payload) > maxFragmentBytes {
		return invalidate()
	}
	if offset == 0 {
		e.header = append([]byte(nil), packet[:hlen]...)
	}
	e.parts = append(e.parts, fragmentPart{offset, append([]byte(nil), payload...), more})
	e.size += len(payload)
	f.bytes += len(payload)
	if e.total < 0 || e.header == nil {
		return nil
	}
	if len(e.header)+e.total > 65535 {
		return invalidate()
	}
	sort.Slice(e.parts, func(i, j int) bool { return e.parts[i].offset < e.parts[j].offset })
	next := 0
	for _, part := range e.parts {
		if part.offset != next {
			return nil
		}
		next += len(part.data)
	}
	if next != e.total {
		return nil
	}
	result := make([]byte, len(e.header)+e.total)
	copy(result, e.header)
	for _, part := range e.parts {
		copy(result[len(e.header)+part.offset:], part.data)
	}
	binary.BigEndian.PutUint16(result[2:4], uint16(len(result)))
	binary.BigEndian.PutUint16(result[6:8], 0)
	binary.BigEndian.PutUint16(result[10:12], 0)
	binary.BigEndian.PutUint16(result[10:12], ipv4Checksum(result[:len(e.header)]))
	f.bytes -= e.size
	delete(f.entries, key)
	return result
}
