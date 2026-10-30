package winproxy

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type ownedProxyState struct {
	Managed   bool   `json:"managedByBlueWing"`
	Server    string `json:"managedServer"`
	UpdatedAt int64  `json:"updatedAt"`
	Original  struct {
		Enabled     bool         `json:"enabled"`
		Server      string       `json:"server"`
		Override    string       `json:"override"`
		Connections []Connection `json:"connections"`
	} `json:"originalSnapshot"`
}

func localProxyAddress(address string) bool {
	host, port, e := net.SplitHostPort(address)
	if e != nil {
		return false
	}
	n, e := strconv.Atoi(port)
	if e != nil || n < 1 || n > 65535 {
		return false
	}
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

// Run independently of Electron after login and after an unexpected app exit.
// Only a dead loopback proxy explicitly owned by this application is restored.
func RecoverNetwork(file string) error {
	return recoverNetwork(file, func(address string) bool {
		c, e := net.DialTimeout("tcp", address, 350*time.Millisecond)
		if e != nil {
			return false
		}
		_ = c.Close()
		return true
	}, execute)
}
func recoverNetwork(file string, alive func(string) bool, apply func(Request) ([]Connection, error)) error {
	data, e := os.ReadFile(file)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	var state ownedProxyState
	if json.Unmarshal([]byte(strings.TrimPrefix(string(data), "\ufeff")), &state) != nil || !state.Managed || !localProxyAddress(state.Server) {
		return nil
	}
	if alive(state.Server) {
		return nil
	}
	before, e := apply(Request{Action: "query"})
	if e != nil {
		return e
	}
	desired := append([]Connection(nil), state.Original.Connections...)
	if len(desired) == 0 {
		for _, c := range before {
			if c.Server == state.Server {
				c.Flags = 1
				c.Server = ""
				c.PAC = ""
				if c.Name == "" && state.Original.Enabled && state.Original.Server != state.Server {
					c.Flags = 3
					c.Server = state.Original.Server
					c.Bypass = state.Original.Override
				}
				desired = append(desired, c)
			}
		}
	}
	for i := range desired {
		if desired[i].Server == state.Server && desired[i].Flags&2 != 0 {
			desired[i].Flags = (desired[i].Flags &^ 2) | 1
			desired[i].Server = ""
		}
	}
	// A new app instance may have started during the query. Its listener is
	// ready before it enables the proxy, so never race that instance's takeover.
	if alive(state.Server) {
		return nil
	}
	if _, e = apply(Request{Action: "restore", ManagedServer: state.Server, Connections: desired}); e != nil {
		return e
	}
	latest, e := os.ReadFile(file)
	if e != nil || string(latest) != string(data) {
		return e
	}
	var original map[string]any
	if e = json.Unmarshal([]byte(strings.TrimPrefix(string(data), "\ufeff")), &original); e != nil {
		return e
	}
	original["managedByBlueWing"] = false
	original["updatedAt"] = time.Now().UnixMilli()
	encoded, e := json.MarshalIndent(original, "", "  ")
	if e != nil {
		return e
	}
	tmp, e := os.CreateTemp(filepath.Dir(file), ".proxy-recovery-*.tmp")
	if e != nil {
		return e
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, e = tmp.Write(encoded); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Close(); e != nil {
		return e
	}
	return os.Rename(name, file)
}
