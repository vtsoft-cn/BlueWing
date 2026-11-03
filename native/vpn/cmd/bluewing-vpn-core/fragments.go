package main

import (
	"time"

	"github.com/mythologyli/zju-connect/internal/ipv4frag"
)

type packetFragments = ipv4frag.Reassembler

func (s *session) preparePacket(packet []byte) []byte {
	packet = s.fragments.Accept(packet, time.Now())
	if packet == nil || !s.allowedPacket(packet) {
		return nil
	}
	return packet
}
