// BlueWing control host for zju-connect v1.3.1. See ../../LICENSE (AGPL-3.0).
package main

import (
	"bufio"
	"container/list"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	stdlog "log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mythologyli/zju-connect/client"
	atrust "github.com/mythologyli/zju-connect/client/atrust"
	"github.com/mythologyli/zju-connect/client/atrust/auth"
	easy "github.com/mythologyli/zju-connect/client/easyconnect"
	softether "github.com/mythologyli/zju-connect/client/softether"
	bridge "github.com/mythologyli/zju-connect/internal/bluewing"
	"github.com/mythologyli/zju-connect/internal/winproxy"
	"github.com/mythologyli/zju-connect/stack/gvisor"
	"github.com/mythologyli/zju-connect/underlay"
)

const protocolVersion = 1
const maxFrame = 4 * 1024 * 1024

var buildRevision = "5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da+bluewing.10-publish-security"

type target struct {
	GuardOnly bool     `json:"guardOnly,omitempty"`
	Domains   []string `json:"domains"`
	CIDRs     []string `json:"cidrs"`
	Ports     []string `json:"ports,omitempty"`
	Network   string   `json:"network,omitempty"`
}
type resources struct {
	Targets    []target            `json:"targets"`
	Hosts      map[string][]string `json:"hosts"`
	DNSServers []string            `json:"dnsServers"`
}
type profile struct {
	ID       string `json:"id"`
	Protocol string `json:"protocol"`
	Gateway  struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	} `json:"gateway"`
	Username            string `json:"username"`
	AuthMethod          string `json:"authMethod"`
	LoginDomain         string `json:"loginDomain"`
	DiagnosticMode      string `json:"diagnosticMode"`
	TrafficMode         string `json:"trafficMode"`
	AutoDiscoverPrivate bool   `json:"autoDiscoverPrivate"`
	CustomRouting       struct {
		Domestic string `json:"domestic"`
		Foreign  string `json:"foreign"`
		LAN      string `json:"lan"`
	} `json:"customRouting"`
	TLS           bridge.Policy       `json:"tls"`
	Targets       []target            `json:"targets"`
	Hosts         map[string][]string `json:"hosts"`
	BindInterface string              `json:"bindInterface"`
	SocksPort     int                 `json:"socksPort"`
	DNSPort       int                 `json:"dnsPort"`
}
type endpointConfig struct {
	Profile       profile `json:"profile"`
	User          string  `json:"user"`
	Password      string  `json:"password"`
	PacketPeerKey string  `json:"packetPeerKey,omitempty"`
	ICMPPeerKey   string  `json:"icmpPeerKey,omitempty"`
}
type command struct {
	V           int              `json:"v"`
	ID          string           `json:"id"`
	Type        string           `json:"type"`
	Generation  int64            `json:"generation"`
	ProfileID   string           `json:"profileId"`
	Profile     profile          `json:"profile"`
	Endpoints   []endpointConfig `json:"endpoints"`
	Password    string           `json:"password"`
	Session     string           `json:"session"`
	ChallengeID string           `json:"challengeId"`
	Value       string           `json:"value"`
}
type event struct {
	V          int    `json:"v"`
	Type       string `json:"type"`
	ID         string `json:"id,omitempty"`
	Generation int64  `json:"generation"`
	ProfileID  string `json:"profileId,omitempty"`
	Data       any    `json:"data,omitempty"`
	Code       string `json:"code,omitempty"`
}
type session struct {
	lifeMu          sync.Mutex
	setupDone       chan struct{}
	probeMu         sync.RWMutex
	probe           string
	ctx             context.Context
	cancel          context.CancelFunc
	p               profile
	gen             int64
	c               client.Client
	closeClient     func()
	stack           *gvisor.Stack
	dialer          *underlay.Dialer
	resources       resources
	domainResources client.DomainResources
	leaseMu         sync.RWMutex
	leases          map[string]dnsLease
	leaseOrder      list.List
	connsMu         sync.Mutex
	conns           map[net.Conn]struct{}
	privateRoutes   *privateRoutePicker
	fragments       packetFragments
}
type dnsLease struct {
	domain  string
	expires time.Time
	order   *list.Element
}
type controller struct {
	outMu      sync.Mutex
	mu         sync.RWMutex
	endpoints  map[string]*endpoint
	active     *session
	pending    *session
	promptMu   sync.Mutex
	challenges map[string]chan string
	jobs       sync.WaitGroup
	closing    chan struct{}
}

func (c *controller) emit(e event) {
	c.outMu.Lock()
	defer c.outMu.Unlock()
	e.V = protocolVersion
	_ = json.NewEncoder(os.Stdout).Encode(e)
}
func token() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func (c *controller) prompt(s *session) bridge.Prompt {
	return func(kind, title string, img []byte) (string, error) {
		if len(img) > 1024*1024 {
			return "", errors.New("challenge too large")
		}
		id := token()
		ch := make(chan string, 1)
		c.promptMu.Lock()
		c.challenges[id] = ch
		c.promptMu.Unlock()
		defer func() { c.promptMu.Lock(); delete(c.challenges, id); c.promptMu.Unlock() }()
		data := map[string]any{"id": id, "generation": s.gen, "profileId": s.p.ID, "kind": kind, "title": title, "expiresAt": time.Now().Add(2 * time.Minute).UnixMilli()}
		if len(img) > 0 {
			mime := http.DetectContentType(img)
			if mime != "image/jpeg" && mime != "image/png" && mime != "image/gif" && mime != "image/webp" {
				return "", errors.New("unsupported challenge image")
			}
			data["imageBase64"] = base64.StdEncoding.EncodeToString(img)
			data["mime"] = mime
		}
		c.emit(event{Type: "challenge", Generation: s.gen, ProfileID: s.p.ID, Data: data})
		select {
		case value := <-ch:
			return value, nil
		case <-s.ctx.Done():
			return "", s.ctx.Err()
		case <-time.After(2 * time.Minute):
			return "", errors.New("AUTH_CHALLENGE_EXPIRED")
		}
	}
}
func (s *session) close() {
	s.cancel()
	s.lifeMu.Lock()
	defer s.lifeMu.Unlock()
	if s.closeClient != nil {
		s.closeClient()
	}
	if s.stack != nil {
		s.stack.Close()
	}
	if s.dialer != nil {
		_ = s.dialer.Close()
	}
	s.connsMu.Lock()
	defer s.connsMu.Unlock()
	for conn := range s.conns {
		_ = conn.Close()
	}
}
func (c *controller) stop() {
	c.mu.Lock()
	a, p := c.active, c.pending
	c.active = nil
	c.pending = nil
	c.mu.Unlock()
	if a != nil {
		a.close()
	}
	if p != nil && p != a {
		p.close()
		if p.setupDone != nil {
			<-p.setupDone
		}
	}
}
func normalizeHost(h string) string { return strings.ToLower(strings.TrimSuffix(h, ".")) }
func safeCode(err error) string {
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "75500503") {
		return "ATRUST_TRUSTED_ENDPOINT_REQUIRED"
	}
	if strings.Contains(text, "softether_client_version_unsupported") {
		return "SOFTETHER_CLIENT_VERSION_UNSUPPORTED"
	}
	if strings.Contains(text, "softether_dhcp_failed") {
		return "SOFTETHER_DHCP_FAILED"
	}
	if strings.Contains(text, "softether_transport_unsupported") {
		return "SOFTETHER_TRANSPORT_UNSUPPORTED"
	}
	if strings.Contains(text, "virtual hub was not found") {
		return "SOFTETHER_HUB_NOT_FOUND"
	}
	if strings.Contains(text, "authentication failed") {
		return "AUTH_FAILED"
	}
	if strings.Contains(text, "pin mismatch") {
		return "TLS_CERT_CHANGED"
	}
	if strings.Contains(text, "resource_schema_unsupported") {
		return "RESOURCE_SCHEMA_UNSUPPORTED"
	}
	if strings.Contains(text, "certificate") || strings.Contains(text, "x509") || strings.Contains(text, "tls_untrusted") {
		return "TLS_UNTRUSTED"
	}
	if strings.Contains(text, "auth_challenge_expired") {
		return "AUTH_CHALLENGE_EXPIRED"
	}
	if errors.Is(err, context.Canceled) {
		return "AUTH_CANCELLED"
	}
	if strings.Contains(text, "auth_method_unsupported") {
		return "AUTH_METHOD_UNSUPPORTED"
	}
	if strings.Contains(text, "timeout") || strings.Contains(text, "connectex") || strings.Contains(text, "no usable underlay") {
		return "GATEWAY_UNREACHABLE"
	}
	return "AUTH_OR_TUNNEL_FAILED"
}
func (c *controller) setup(s *session, password, sessionData string) (res resources, err error) {
	bridge.Configure(s.ctx, s.p.TLS, c.prompt(s))
	c.configureDiagnostics(s)
	s.lifeMu.Lock()
	s.dialer, err = underlay.New(underlay.Options{InterfaceName: s.p.BindInterface, AutoDetect: s.p.BindInterface == ""})
	s.lifeMu.Unlock()
	if err != nil {
		return res, err
	}
	switch s.p.Protocol {
	case "softether":
		method := softether.AuthPassword
		if s.p.AuthMethod == "softether/radius" {
			method = softether.AuthPlainPassword
		} else if s.p.AuthMethod != "auth/psw" {
			return res, errors.New("AUTH_METHOD_UNSUPPORTED")
		}
		sc := softether.NewClient(softether.Config{Server: s.p.Gateway.Host, Port: s.p.Gateway.Port, Hub: s.p.LoginDomain, Username: s.p.Username, Password: password, AuthType: method, TLS: bridge.TLS(s.p.Gateway.Host), DialContext: s.dialer.DialContext})
		s.lifeMu.Lock()
		s.c = sc
		s.closeClient = sc.Close
		s.lifeMu.Unlock()
		err = sc.Setup(s.ctx)
	case "easyconnect":
		ec := easy.NewClient(easy.Options{Server: net.JoinHostPort(s.p.Gateway.Host, strconv.Itoa(s.p.Gateway.Port)), Auth: easy.AuthOptions{Username: s.p.Username, Password: password}, Resources: easy.ResourceOptions{Fetch: true, IncludeDomains: true}, UnderlayDialer: s.dialer})
		s.lifeMu.Lock()
		s.c = ec
		s.closeClient = ec.Close
		s.lifeMu.Unlock()
		if s.ctx.Err() != nil {
			return res, s.ctx.Err()
		}
		err = ec.Setup()
	case "atrust":
		ac := atrust.NewClient(atrust.ClientOptions{UnderlayDialer: s.dialer})
		s.lifeMu.Lock()
		s.c = ac
		s.closeClient = ac.Close
		s.lifeMu.Unlock()
		if s.ctx.Err() != nil {
			return res, s.ctx.Err()
		}
		var method auth.LoginMethod
		switch s.p.AuthMethod {
		case "auth/psw":
			method = auth.PasswordLogin{Username: s.p.Username, Password: password, Domain: s.p.LoginDomain}
		case "auth/smsCheckCode":
			method = auth.SMSLogin{Phone: s.p.Username, Domain: s.p.LoginDomain}
		default:
			return res, errors.New("AUTH_METHOD_UNSUPPORTED")
		}
		var cached []byte
		if sessionData != "" {
			cached = []byte(sessionData)
		}
		var saved []byte
		saved, err = ac.Setup(atrust.SetupOptions{ServerAddress: s.p.Gateway.Host, ServerPort: s.p.Gateway.Port, LoginMethod: method, ClientData: cached, BestNodesRefreshInterval: time.Minute})
		if err == nil {
			c.emit(event{Type: "sessionUpdated", Generation: s.gen, ProfileID: s.p.ID, Data: string(saved)})
		}
	default:
		return res, errors.New("AUTH_METHOD_UNSUPPORTED")
	}
	if err != nil {
		return res, err
	}
	if s.ctx.Err() != nil {
		return res, s.ctx.Err()
	}
	c.emit(event{Type: "authenticated", Generation: s.gen, ProfileID: s.p.ID})
	res, err = extractResources(s.c)
	if err != nil {
		return res, err
	}
	s.domainResources, err = s.c.DomainResources()
	if err != nil {
		return res, err
	}
	s.resources = res
	s.lifeMu.Lock()
	s.stack, err = gvisor.NewStack(s.c)
	if err == nil {
		s.stack.SetFailureHandler(func() {
			if s.ctx.Err() == nil {
				c.fail(s, "VPN_TRANSPORT_DOWN")
			}
		})
	}
	s.lifeMu.Unlock()
	if err != nil {
		return res, err
	}
	if s.ctx.Err() != nil {
		return res, s.ctx.Err()
	}
	if err = s.stack.Prepare(); err != nil {
		return res, err
	}
	if ep := c.endpoints[s.p.ID]; ep != nil && ep.packet != nil {
		if err = s.stack.EnablePackets(ep.returnPackets()); err != nil {
			return res, err
		}
	}
	s.privateRoutes = &privateRoutePicker{publicTCP: s.p.Protocol == "softether", local: s.dialer.DialContext, vpn: func(ctx context.Context, _ string, address string) (net.Conn, error) {
		host, portText, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return nil, err
		}
		return s.stack.DialTCP(ctx, &net.TCPAddr{IP: net.ParseIP(host), Port: port})
	}}
	return res, nil
}
func (c *controller) connect(cmd command) {
	c.stop()
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{ctx: ctx, cancel: cancel, p: cmd.Profile, gen: cmd.Generation, conns: make(map[net.Conn]struct{}), leases: make(map[string]dnsLease), setupDone: make(chan struct{})}
	c.mu.Lock()
	c.pending = s
	c.mu.Unlock()
	c.jobs.Add(1)
	go func() {
		defer c.jobs.Done()
		defer close(s.setupDone)
		defer func() {
			if recover() != nil {
				c.fail(s, "VPN_TRANSPORT_DOWN")
			}
		}()
		res, err := c.setup(s, cmd.Password, cmd.Session)
		cmd.Password = ""
		cmd.Session = ""
		if err != nil {
			c.fail(s, safeCode(err), err)
			return
		}
		c.mu.Lock()
		if c.pending != s || s.ctx.Err() != nil {
			c.mu.Unlock()
			s.close()
			return
		}
		c.pending = nil
		c.active = s
		c.mu.Unlock()
		go func() {
			defer func() {
				if recover() != nil && s.ctx.Err() == nil {
					c.fail(s, "VPN_TRANSPORT_DOWN")
				}
			}()
			s.stack.Run()
			if s.ctx.Err() == nil {
				c.fail(s, "VPN_TRANSPORT_DOWN")
			}
		}()
		c.emit(event{Type: "resources", Generation: s.gen, ProfileID: s.p.ID, Data: res})
		c.emit(event{Type: "tunnelReady", Generation: s.gen, ProfileID: s.p.ID})
	}()
}
func (c *controller) configureDiagnostics(s *session) {
	var trace func(map[string]any)
	if s.p.DiagnosticMode == "full" || s.p.DiagnosticMode == "detail" {
		trace = func(data map[string]any) {
			c.emit(event{Type: "diagnostic", Generation: s.gen, ProfileID: s.p.ID, Data: data})
		}
	}
	bridge.SetDiagnostics(trace, s.p.DiagnosticMode == "full")
}
func failureDetail(err error) map[string]any {
	message := err.Error()
	stage := "connection-setup"
	if i := strings.Index(message, " failed"); i > 0 {
		stage = message[:i]
	}
	detail := map[string]any{"stage": stage, "message": message}
	if i := strings.Index(message, "code "); i >= 0 {
		number := strings.Fields(message[i+5:])
		if len(number) > 0 {
			detail["serverCode"] = strings.TrimRight(number[0], ":,;")
		}
	}
	return detail
}
func (c *controller) fail(s *session, code string, original ...error) {
	c.mu.Lock()
	current := c.active == s || c.pending == s
	if c.active == s {
		c.active = nil
	}
	if c.pending == s {
		c.pending = nil
	}
	c.mu.Unlock()
	s.close()
	if current {
		var detail any
		if len(original) > 0 {
			detail = failureDetail(original[0])
		}
		c.emit(event{Type: "error", Generation: s.gen, ProfileID: s.p.ID, Code: code, Data: detail})
	}
}
func (c *controller) discover(cmd command) {
	c.stop()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s := &session{ctx: ctx, cancel: cancel, p: cmd.Profile, gen: cmd.Generation}
	bridge.Configure(ctx, s.p.TLS, c.prompt(s))
	c.configureDiagnostics(s)
	infos, err := atrust.GetAuthInfoList(s.p.Gateway.Host, s.p.Gateway.Port, s.p.BindInterface, s.p.BindInterface == "", "", "")
	if err != nil {
		c.emit(event{Type: "error", ID: cmd.ID, Generation: cmd.Generation, ProfileID: s.p.ID, Code: safeCode(err)})
		return
	}
	result := []map[string]any{}
	for _, info := range infos {
		result = append(result, map[string]any{"loginDomain": info.LoginDomain, "authType": info.AuthType, "authName": info.AuthName, "supported": info.AuthType == "auth/psw" || info.AuthType == "auth/smsCheckCode"})
	}
	c.emit(event{Type: "authMethods", ID: cmd.ID, Generation: cmd.Generation, ProfileID: s.p.ID, Data: result})
}
func extractResources(v client.Client) (resources, error) {
	res := resources{Targets: []target{}, Hosts: map[string][]string{}, DNSServers: []string{}}
	ips, err := v.IPResources()
	if err != nil {
		return res, err
	}
	for _, r := range ips {
		first, ok := netip.AddrFromSlice(r.IPMin)
		if !ok {
			return res, errors.New("RESOURCE_SCHEMA_UNSUPPORTED")
		}
		last, ok := netip.AddrFromSlice(r.IPMax)
		if !ok {
			return res, errors.New("RESOURCE_SCHEMA_UNSUPPORTED")
		}
		cidrs, err := rangeCIDRs(first.Unmap(), last.Unmap())
		if err != nil {
			return res, err
		}
		res.Targets = append(res.Targets, resourceTarget(nil, cidrs, r.PortMin, r.PortMax, r.Protocol)...)
	}
	domains, err := v.DomainResources()
	if err != nil {
		return res, err
	}
	for d, entries := range domains {
		for _, r := range entries {
			res.Targets = append(res.Targets, resourceTarget([]string{strings.TrimPrefix(d, "*.")}, nil, r.PortMin, r.PortMax, r.Protocol)...)
		}
	}
	entries, err := v.DNSResource()
	if err != nil {
		return res, err
	}
	for name, ips := range entries {
		for _, ip := range ips {
			res.Hosts[normalizeHost(name)] = append(res.Hosts[normalizeHost(name)], ip.String())
		}
	}
	servers, err := v.DNSServers()
	if err != nil {
		return res, err
	}
	for _, ip := range servers {
		if net.ParseIP(ip) != nil {
			res.DNSServers = append(res.DNSServers, ip)
		}
	}
	if len(res.Targets) > 4096 {
		return res, errors.New("RESOURCE_SCHEMA_UNSUPPORTED")
	}
	return res, nil
}
func resourceTarget(domains, cidrs []string, min, max int, network string) []target {
	if domains == nil {
		domains = []string{}
	}
	if cidrs == nil {
		cidrs = []string{}
	}
	t := target{Domains: domains, CIDRs: cidrs}
	if min > 0 && max >= min && max <= 65535 {
		t.Ports = []string{fmt.Sprintf("%d:%d", min, max)}
	}
	switch strings.ToLower(network) {
	case "tcp", "udp":
		t.Network = strings.ToLower(network)
		return []target{t}
	case "all", "":
		return []target{t}
	default:
		t.GuardOnly = true
		return []target{t}
	}
}
func rangeCIDRs(first, last netip.Addr) ([]string, error) {
	if first.BitLen() != last.BitLen() || first.Compare(last) > 0 {
		return nil, errors.New("invalid resource range")
	}
	if first.IsUnspecified() && prefixLast(netip.PrefixFrom(first, 0)) == last {
		return nil, errors.New("default resource range is unsupported")
	}
	result := []string{}
	for first.IsValid() && first.Compare(last) <= 0 {
		bits := first.BitLen()
		best := netip.PrefixFrom(first, bits)
		for prefix := bits - 1; prefix > 0; prefix-- {
			p := netip.PrefixFrom(first, prefix)
			if p.Masked().Addr() != first {
				break
			}
			end := prefixLast(p)
			if end.Compare(last) > 0 {
				break
			}
			best = p
		}
		result = append(result, best.String())
		if len(result) > 4096 {
			return nil, errors.New("resource range too large")
		}
		first = prefixLast(best).Next()
	}
	return result, nil
}
func prefixLast(p netip.Prefix) netip.Addr {
	b := p.Addr().As16()
	offset := 0
	if p.Addr().Is4() {
		offset = 96
	}
	for bit := p.Bits() + offset; bit < 128; bit++ {
		b[bit/8] |= 1 << uint(7-bit%8)
	}
	return netip.AddrFrom16(b).Unmap()
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--release-network" {
		if err := winproxy.ReleaseNetwork(os.Args[2]); err != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "--recover-network" {
		_ = winproxy.RecoverNetwork(os.Args[2])
		return
	}
	if len(os.Args) == 4 && os.Args[1] == "--watch-network" {
		if pid, e := strconv.Atoi(os.Args[3]); e == nil && pid > 0 {
			_ = winproxy.WatchRecovery(os.Args[2], pid)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--system-proxy" {
		winproxy.Run(os.Stdin, os.Stdout)
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("bluewing-vpn-core " + buildRevision)
		return
	}
	if len(os.Args) != 2 || os.Args[1] != "--control=stdio-json" {
		fmt.Fprintln(os.Stderr, "use --control=stdio-json")
		os.Exit(2)
	}
	// Upstream human logs contain tokens and plaintext challenge data. They never enter the host log bus.
	stdlog.SetOutput(io.Discard)
	c := &controller{endpoints: make(map[string]*endpoint), challenges: make(map[string]chan string), closing: make(chan struct{})}
	c.emit(event{Type: "hello", Data: map[string]any{"protocolVersion": protocolVersion, "revision": buildRevision, "protocols": []string{"easyconnect", "atrust", "softether"}, "udp": false}})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), maxFrame)
	for scanner.Scan() {
		var cmd command
		if json.Unmarshal(scanner.Bytes(), &cmd) != nil || cmd.V != protocolVersion || len(cmd.ID) > 100 {
			c.emit(event{Type: "error", Code: "INVALID_COMMAND"})
			continue
		}
		switch cmd.Type {
		case "configure":
			if err := c.configure(cmd.Endpoints); err != nil {
				c.emit(event{Type: "error", ID: cmd.ID, Code: "LOCAL_PORT_IN_USE"})
			} else {
				c.emit(event{Type: "endpointsReady", ID: cmd.ID, Data: map[string]any{"packets": c.packetEndpoints()}})
			}
		case "connect":
			c.connect(cmd)
		case "disconnect":
			c.stop()
			c.emit(event{Type: "stopped", Generation: cmd.Generation})
		case "setProbe":
			c.mu.RLock()
			s := c.active
			if s != nil && s.gen == cmd.Generation {
				s.probeMu.Lock()
				s.probe = cmd.Value
				s.probeMu.Unlock()
			}
			c.mu.RUnlock()
		case "respond":
			c.mu.RLock()
			s := c.pending
			c.mu.RUnlock()
			if s == nil || s.gen != cmd.Generation {
				continue
			}
			c.promptMu.Lock()
			ch := c.challenges[cmd.ChallengeID]
			delete(c.challenges, cmd.ChallengeID)
			c.promptMu.Unlock()
			if ch != nil {
				ch <- cmd.Value
			}
		case "discoverAuth":
			c.jobs.Add(1)
			go func() { defer c.jobs.Done(); c.discover(cmd) }()
		case "serverCertificate":
			go c.certificate(cmd)
		case "shutdown":
			c.stop()
			c.closeEndpoints()
			return
		default:
			c.emit(event{Type: "error", ID: cmd.ID, Code: "INVALID_COMMAND"})
		}
	}
	c.stop()
	c.closeEndpoints()
}
