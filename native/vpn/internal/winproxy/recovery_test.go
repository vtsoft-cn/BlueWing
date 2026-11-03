package winproxy

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
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
		if r.Action == "query" {
			return []Connection{{Flags: 3, Server: state.Server}}, nil
		}
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

func TestWatcherRecoversRoutingChildFailureWhileParentIsAlive(t *testing.T) {
	waits, recoveries := 0, 0
	err := watchRecovery(func(interval time.Duration) (bool, error) {
		if interval > 5*time.Second {
			t.Fatal("recovery interval is unbounded")
		}
		waits++
		return waits == 3, nil
	}, func(done bool) error {
		recoveries++
		if done != (recoveries == 3) {
			t.Fatal("parent exit was not propagated")
		}
		if recoveries == 1 {
			return errors.New("temporary WinINet failure")
		}
		return nil
	})
	if err != nil || recoveries != 3 {
		t.Fatalf("guard stopped before recovering a live parent's child: %d %v", recoveries, err)
	}
}

func TestExitedOwnerReleasesOrphanProxyButDoesNotTouchNewInstance(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proxy_ownership.json")
	for _, owner := range []int{123, 456} {
		state := ownedProxyState{Managed: true, Server: "127.0.0.1:2080", OwnerPID: owner}
		data, _ := json.Marshal(state)
		os.WriteFile(file, data, 0600)
		calls := 0
		err := recoverNetworkMode(file, func(string) bool { return true }, func(r Request) ([]Connection, error) {
			calls++
			return []Connection{{Flags: 3, Server: state.Server}}, nil
		}, 123, true)
		if err != nil {
			t.Fatal(err)
		}
		if (calls > 0) != (owner == 123) {
			t.Fatal("orphan/new-instance ownership was confused")
		}
	}
}

func TestRestorePlanPreservesPACExternalChangesAndNewRAS(t *testing.T) {
	server := "127.0.0.1:2080"
	before := []Connection{{Name: "", Flags: 3, Server: "new-user-proxy:8080"}, {Name: "office", Flags: 3, Server: server}, {Name: "new-dialup", Flags: 3, Server: server}}
	wanted := []Connection{{Name: "", Flags: 1}, {Name: "office", Flags: 5, PAC: "https://office.example/proxy.pac"}}
	got, err := restoreConnections(before, Request{ManagedServer: server, Connections: wanted})
	if err != nil || len(got) != 2 {
		t.Fatalf("invalid restore plan: %+v %v", got, err)
	}
	if got[0] != wanted[1] {
		t.Fatal("original PAC was lost")
	}
	if got[1].Name != "new-dialup" || got[1].Flags != 1 || got[1].Server != "" {
		t.Fatal("new RAS entry kept a dead proxy")
	}
	if _, err := restoreConnections(before, Request{Connections: wanted}); err == nil {
		t.Fatal("unowned restore accepted")
	}
}

func TestFailedRecoveryRetainsOwnershipForRetry(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proxy_ownership.json")
	state := ownedProxyState{Managed: true, Server: "127.0.0.1:2080"}
	data, _ := json.Marshal(state)
	os.WriteFile(file, data, 0600)
	err := recoverNetwork(file, func(string) bool { return false }, func(r Request) ([]Connection, error) {
		if r.Action == "restore" {
			return nil, errors.New("write failed")
		}
		return []Connection{{Flags: 3, Server: state.Server}}, nil
	})
	if err == nil {
		t.Fatal("failed restore was ignored")
	}
	after, _ := os.ReadFile(file)
	if string(after) != string(data) {
		t.Fatal("failed restore lost recovery ownership")
	}
}

func TestPortTransitionRecoversDeadActualPortWhileNewPortIsLive(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proxy_ownership.json")
	old, newPort := "127.0.0.1:2080", "127.0.0.1:2081"
	state := ownedProxyState{Managed: true, Server: newPort, Servers: []string{old, newPort}}
	state.Original.Connections = []Connection{{Name: "", Flags: 1}, {Name: "office", Flags: 5, PAC: "https://office.example/proxy.pac"}}
	data, _ := json.Marshal(state)
	os.WriteFile(file, data, 0600)
	current := []Connection{{Name: "", Flags: 3, Server: old}, {Name: "office", Flags: 3, Server: newPort}, {Name: "external", Flags: 3, Server: "other-proxy:8080"}}
	apply := func(req Request) ([]Connection, error) {
		if req.Action == "query" {
			return append([]Connection(nil), current...), nil
		}
		plan, e := restoreConnections(current, req)
		if e != nil {
			return nil, e
		}
		for i := range current {
			for _, c := range plan {
				if current[i].Name == c.Name {
					current[i] = c
				}
			}
		}
		return append([]Connection(nil), current...), nil
	}
	if e := recoverNetwork(file, func(server string) bool { return server == newPort }, apply); e != nil {
		t.Fatal(e)
	}
	if current[0].Server != "" || current[1].Server != newPort || current[2].Server != "other-proxy:8080" {
		t.Fatal("transition recovery changed the wrong connection", current)
	}
	saved, _ := os.ReadFile(file)
	json.Unmarshal(saved, &state)
	if !state.Managed {
		t.Fatal("live RAS ownership was released too early")
	}
	if e := recoverNetwork(file, func(string) bool { return false }, apply); e != nil {
		t.Fatal(e)
	}
	if current[1].PAC != "https://office.example/proxy.pac" {
		t.Fatal("final transition recovery lost PAC")
	}
	saved, _ = os.ReadFile(file)
	json.Unmarshal(saved, &state)
	if state.Managed {
		t.Fatal("completed recovery still owns proxy")
	}
}
