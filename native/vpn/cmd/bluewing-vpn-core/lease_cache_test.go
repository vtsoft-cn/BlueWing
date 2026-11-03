package main

import (
	"fmt"
	"testing"
	"time"
)

func TestDNSLeasesHaveHardBoundAndRefreshRecency(t *testing.T) {
	s := new(session)
	now := time.Now()
	for i := 0; i < maxDNSLeases; i++ {
		s.rememberDNSLease(fmt.Sprint(i), "corp.example", time.Minute, now)
	}
	s.rememberDNSLease("0", "renewed.corp.example", 2*time.Minute, now)
	for i := maxDNSLeases; i < maxDNSLeases+128; i++ {
		s.rememberDNSLease(fmt.Sprint(i), "corp.example", time.Minute, now)
	}
	if len(s.leases) != maxDNSLeases || s.leaseOrder.Len() != maxDNSLeases {
		t.Fatalf("unbounded map/index: %d %d", len(s.leases), s.leaseOrder.Len())
	}
	if s.leases["0"].domain != "renewed.corp.example" || !s.leases["0"].expires.Equal(now.Add(2*time.Minute)) {
		t.Fatal("refreshed lease was evicted or stale")
	}
	if _, exists := s.leases["1"]; exists {
		t.Fatal("oldest lease retained")
	}
	s.rememberDNSLease("0", "corp.example", 0, now)
	if _, exists := s.leases["0"]; exists || s.leaseOrder.Len() != len(s.leases) {
		t.Fatal("TTL zero left authorization or index behind")
	}
}
