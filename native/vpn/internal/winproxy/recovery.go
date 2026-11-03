package winproxy

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type ownedProxyState struct {
	Managed   bool     `json:"managedByBlueWing"`
	Server    string   `json:"managedServer"`
	UpdatedAt int64    `json:"updatedAt"`
	OwnerPID  int      `json:"ownerPid"`
	Servers   []string `json:"managedServers,omitempty"`
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
	return recoverOwnedNetwork(file, 0, false)
}

// Explicit installer/uninstaller release. A live listener is not a reason to
// retain this application's takeover; external PAC/manual changes are preserved.
func ReleaseNetwork(file string) error {
	return releaseNetwork(file, execute)
}

func releaseNetwork(file string, apply func(Request) ([]Connection, error)) error {
	data, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var state ownedProxyState
	if err = json.Unmarshal([]byte(strings.TrimPrefix(string(data), "\ufeff")), &state); err != nil {
		return err
	}
	if !state.Managed {
		return nil
	}
	servers, err := ownedServers(state.Server, state.Servers)
	if err != nil {
		return err
	}
	if err = recoverNetwork(file, func(string) bool { return false }, apply); err != nil {
		return err
	}
	after, err := apply(Request{Action: "query"})
	if err != nil {
		return err
	}
	for _, current := range after {
		if current.Flags&2 != 0 && servers[current.Server] {
			return errors.New("owned proxy is still enabled; recovery data must be retained")
		}
	}
	return nil
}
func recoverOwnedNetwork(file string, ownerPID int, parentExited bool) error {
	return recoverNetworkMode(file, func(address string) bool {
		c, e := net.DialTimeout("tcp", address, 350*time.Millisecond)
		if e != nil {
			return false
		}
		_ = c.Close()
		return true
	}, execute, ownerPID, parentExited)
}
func recoverNetwork(file string, alive func(string) bool, apply func(Request) ([]Connection, error)) error {
	return recoverNetworkMode(file, alive, apply, 0, false)
}
func recoverNetworkMode(file string, alive func(string) bool, apply func(Request) ([]Connection, error), ownerPID int, parentExited bool) error {
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
	servers, err := ownedServers(state.Server, state.Servers)
	if err != nil {
		return nil
	}
	if ownerPID > 0 && state.OwnerPID > 0 && state.OwnerPID != ownerPID {
		return nil
	}
	// A surviving routing child is an orphan after its recorded owner exits.
	// Never apply that exception to a newer instance's ownership record.
	orphan := parentExited && ownerPID > 0 && state.OwnerPID == ownerPID
	if !orphan && len(servers) == 1 && alive(state.Server) {
		return nil
	}
	before, e := apply(Request{Action: "query"})
	if e != nil {
		return e
	}
	desired := append([]Connection(nil), state.Original.Connections...)
	if len(desired) == 0 {
		c := Connection{Flags: 1}
		if state.Original.Enabled && !servers[state.Original.Server] {
			c.Flags, c.Server, c.Bypass = 3, state.Original.Server, state.Original.Override
		}
		desired = []Connection{c}
	}
	// A new app instance may have started during the query. Its listener is
	// ready before it enables the proxy, so never race that instance's takeover.
	latestBeforeRestore, readErr := os.ReadFile(file)
	if os.IsNotExist(readErr) {
		return nil
	}
	if readErr != nil {
		return readErr
	}
	if string(latestBeforeRestore) != string(data) {
		return nil
	}
	// In a port transition the preferred new listener may be alive while
	// WinINet still points at the dead old one. Decide per actual connection.
	eligible := make(map[string]bool)
	for _, current := range before {
		if current.Flags&2 != 0 && servers[current.Server] && (orphan || !alive(current.Server)) {
			eligible[current.Server] = true
		}
	}
	if len(eligible) == 0 {
		return nil
	}
	// A replacement may have bound a port during the query.
	if !orphan {
		for server := range eligible {
			if alive(server) {
				delete(eligible, server)
			}
		}
	}
	if len(eligible) == 0 {
		return nil
	}
	addresses := make([]string, 0, len(eligible))
	for server := range eligible {
		addresses = append(addresses, server)
	}
	// Sanitize all historical BlueWing addresses in the original snapshot.
	for i := range desired {
		if servers[desired[i].Server] {
			desired[i].Flags = (desired[i].Flags &^ 2) | 1
			desired[i].Server = ""
		}
	}
	plan, e := restoreConnections(before, Request{ManagedServer: addresses[0], ManagedServers: addresses, Connections: desired})
	if e != nil {
		return e
	}
	after, e := apply(Request{Action: "restore", ManagedServer: addresses[0], ManagedServers: addresses, Connections: plan})
	if e != nil {
		return e
	}
	if len(after) == 0 {
		after = append([]Connection(nil), before...)
		for i := range after {
			for _, restored := range plan {
				if restored.Name == after[i].Name {
					after[i] = restored
				}
			}
		}
	}
	remaining := false
	for _, current := range after {
		if current.Flags&2 != 0 && servers[current.Server] {
			remaining = true
		}
	}
	latest, e := os.ReadFile(file)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil || string(latest) != string(data) {
		return e
	}
	var original map[string]any
	if e = json.Unmarshal([]byte(strings.TrimPrefix(string(data), "\ufeff")), &original); e != nil {
		return e
	}
	original["managedByBlueWing"] = remaining
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
	if e = tmp.Sync(); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Close(); e != nil {
		return e
	}
	latest, e = os.ReadFile(file)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil || string(latest) != string(data) {
		return e
	}
	return os.Rename(name, file)
}

// Keep checking while Electron is alive: the routing child can die on its own.
// A transient failure is retried; a live replacement listener is preserved by
// RecoverNetwork's ownership and liveness checks.
func watchRecovery(wait func(time.Duration) (bool, error), recover func(bool) error) error {
	return watchRecoveryWithRetry(wait, recover, time.Sleep)
}

func watchRecoveryWithRetry(wait func(time.Duration) (bool, error), recover func(bool) error, pause func(time.Duration)) error {
	for {
		done, err := wait(5 * time.Second)
		if err != nil {
			return err
		}
		err = recover(done)
		if done {
			for attempt := 0; err != nil && attempt < 5; attempt++ {
				pause((250 * time.Millisecond) << attempt)
				err = recover(true)
			}
			return err
		}
	}
}
