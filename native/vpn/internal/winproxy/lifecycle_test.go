package winproxy

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDisabledManualProxyPreservesExternalPAC(t *testing.T) {
	current := Connection{Flags: 5, Server: "127.0.0.1:9081", PAC: "https://new-company.example/proxy.pac"}
	changes, err := restoreConnections([]Connection{current}, Request{ManagedServer: current.Server, Connections: []Connection{{Flags: 1}}})
	if err != nil || len(changes) != 0 {
		t.Fatalf("external PAC overwritten: %+v %v", changes, err)
	}
}
func TestParentExitRecoveryRetriesAndBoundsFailures(t *testing.T) {
	for _, permanent := range []bool{false, true} {
		attempts, delays := 0, 0
		err := watchRecoveryWithRetry(func(time.Duration) (bool, error) { return true, nil }, func(exited bool) error {
			if !exited {
				t.Fatal("parent exit flag lost")
			}
			attempts++
			if permanent || attempts == 1 {
				return errors.New("temporary WinINet failure")
			}
			return nil
		}, func(d time.Duration) {
			if d <= 0 || d > 4*time.Second {
				t.Fatal(d)
			}
			delays++
		})
		if permanent {
			if err == nil || attempts != 6 || delays != 5 {
				t.Fatalf("unbounded retry: %d %d %v", attempts, delays, err)
			}
		} else if err != nil || attempts != 2 {
			t.Fatalf("not retried: %d %v", attempts, err)
		}
	}
}
func TestExplicitReleaseCustomPortAndRASPreservesExternalPAC(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proxy_ownership.json")
	state := ownedProxyState{Managed: true, Server: "127.0.0.1:9081"}
	state.Original.Connections = []Connection{{Flags: 5, PAC: "https://original.example/pac"}}
	data, _ := json.Marshal(state)
	os.WriteFile(file, data, 0600)
	current := []Connection{{Flags: 3, Server: state.Server}, {Name: "newRAS", Flags: 3, Server: state.Server}, {Name: "external", Flags: 5, Server: state.Server, PAC: "https://later.example/pac"}}
	apply := func(req Request) ([]Connection, error) {
		if req.Action == "restore" {
			for _, want := range req.Connections {
				for i, got := range current {
					if want.Name == got.Name {
						current[i] = want
					}
				}
			}
		}
		return current, nil
	}
	if err := releaseNetwork(file, apply); err != nil {
		t.Fatal(err)
	}
	if current[0].PAC != "https://original.example/pac" || current[1].Flags != 1 || current[2].PAC != "https://later.example/pac" {
		t.Fatal(current)
	}
}
func TestExplicitReleaseRejectsCorruptOwnershipAndFailedReadback(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proxy_ownership.json")
	os.WriteFile(file, []byte("broken"), 0600)
	if releaseNetwork(file, func(Request) ([]Connection, error) { t.Fatal("invalid ownership used"); return nil, nil }) == nil {
		t.Fatal("invalid ownership accepted")
	}
	state := ownedProxyState{Managed: true, Server: "127.0.0.1:9081"}
	data, _ := json.Marshal(state)
	os.WriteFile(file, data, 0600)
	if releaseNetwork(file, func(Request) ([]Connection, error) { return []Connection{{Flags: 3, Server: state.Server}}, nil }) == nil {
		t.Fatal("failed restore reported success")
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("ownership lost")
	}
}
