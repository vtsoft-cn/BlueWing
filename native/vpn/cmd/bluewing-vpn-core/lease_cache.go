package main

import "time"

const maxDNSLeases = 8192

// Bound both the authorization map and its recency index, including updates to
// existing IPs and TTL=0 answers. No expiry scan is required for each insertion.
func (s *session) rememberDNSLease(ip, domain string, ttl time.Duration, now time.Time) {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	if s.leases == nil {
		s.leases = make(map[string]dnsLease)
	}
	old, exists := s.leases[ip]
	if ttl <= 0 {
		if old.order != nil {
			s.leaseOrder.Remove(old.order)
		}
		delete(s.leases, ip)
		return
	}
	entry := old.order
	if !exists {
		for len(s.leases) >= maxDNSLeases {
			if first := s.leaseOrder.Front(); first != nil {
				delete(s.leases, first.Value.(string))
				s.leaseOrder.Remove(first)
			} else {
				// Also bound maps seeded by adapters/tests without an index.
				for key := range s.leases {
					delete(s.leases, key)
					break
				}
			}
		}
	}
	if entry == nil {
		entry = s.leaseOrder.PushBack(ip)
	} else {
		s.leaseOrder.MoveToBack(entry)
	}
	s.leases[ip] = dnsLease{domain: domain, expires: now.Add(ttl), order: entry}
}
