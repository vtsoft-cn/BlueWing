package winproxy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRecoveryRestoresDeadOwnedProxyBeforeAppStarts(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proxy_ownership.json")
	state := ownedProxyState{Managed: true, Server: "127.0.0.1:2080", UpdatedAt: 1}
	state.Original.Connections = []Connection{{Name: "", Flags: 1}, {Name: "office", Flags: 3, Server: "corporate-proxy:8080"}}
	data, _ := json.Marshal(state)
	os.WriteFile(file, data, 0600)
	var restored Request
	err := recoverNetwork(file, func(string) bool { return false }, func(req Request) ([]Connection, error) {
		if req.Action == "query" {
			return []Connection{{Name: "", Flags: 3, Server: state.Server}, {Name: "office", Flags: 3, Server: state.Server}}, nil
		}
		restored = req
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Action != "restore" || restored.ManagedServer != state.Server || len(restored.Connections) != 2 {
		t.Fatalf("incorrect recovery: %+v", restored)
	}
	if restored.Connections[0].Flags != 1 || restored.Connections[1].Server != "corporate-proxy:8080" {
		t.Fatal("original per-connection proxy settings lost")
	}
	updated, _ := os.ReadFile(file)
	json.Unmarshal(updated, &state)
	if state.Managed {
		t.Fatal("recovery still claims ownership")
	}
}
func TestRecoveryLeavesLiveUnownedAndNonLocalProxyAlone(t *testing.T) {
	for _, tc := range []struct {
		name, server   string
		managed, alive bool
	}{{"live", "127.0.0.1:2080", true, true}, {"unowned", "127.0.0.1:2080", false, false}, {"external", "corp.example:8080", true, false}} {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "proxy_ownership.json")
			state := ownedProxyState{Managed: tc.managed, Server: tc.server}
			data, _ := json.Marshal(state)
			os.WriteFile(file, data, 0600)
			calls := 0
			if err := recoverNetwork(file, func(string) bool { return tc.alive }, func(Request) ([]Connection, error) { calls++; return nil, nil }); err != nil {
				t.Fatal(err)
			}
			if calls != 0 {
				t.Fatal("unrelated/live proxy was changed")
			}
		})
	}
}
func TestRecoveryDoesNotRestoreTheSameDeadProxyOrRaceNewListener(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proxy_ownership.json")
	state := ownedProxyState{Managed: true, Server: "127.0.0.1:2080"}
	state.Original.Connections = []Connection{{Flags: 3, Server: state.Server}}
	data, _ := json.Marshal(state)
	os.WriteFile(file, data, 0600)
	var result Request
	if err := recoverNetwork(file, func(string) bool { return false }, func(r Request) ([]Connection, error) {
		if r.Action == "restore" {
			result = r
		}
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	if result.Connections[0].Flags&2 != 0 || result.Connections[0].Server != "" {
		t.Fatal("dead proxy was reinstated")
	}
	os.WriteFile(file, data, 0600)
	checks, restores := 0, 0
	if err := recoverNetwork(file, func(string) bool { checks++; return checks > 1 }, func(r Request) ([]Connection, error) {
		if r.Action == "restore" {
			restores++
		}
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	if restores != 0 {
		t.Fatal("new application listener lost its proxy")
	}
}
