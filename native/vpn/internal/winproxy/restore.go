package winproxy

import "errors"

func ownedServers(primary string, aliases []string) (map[string]bool, error) {
	if len(aliases) > 32 {
		return nil, errors.New("too many owned proxy addresses")
	}
	servers := make(map[string]bool)
	for _, server := range append([]string{primary}, aliases...) {
		if !localProxyAddress(server) {
			return nil, errors.New("restore requires owned loopback proxies")
		}
		servers[server] = true
	}
	return servers, nil
}

// Restore only connections still owned by this instance. A RAS entry created
// after the initial snapshot must not keep a dead proxy when the app exits.
func restoreConnections(before []Connection, req Request) ([]Connection, error) {
	servers, err := ownedServers(req.ManagedServer, req.ManagedServers)
	if err != nil {
		return nil, err
	}
	originals := make(map[string]Connection, len(req.Connections))
	for _, c := range req.Connections {
		originals[c.Name] = c
	}
	var changes []Connection
	for _, current := range before {
		if current.Flags&2 == 0 || !servers[current.Server] {
			continue
		}
		desired, ok := originals[current.Name]
		if !ok {
			desired = Connection{Name: current.Name, Flags: 1}
		}
		if servers[desired.Server] {
			desired.Flags = (desired.Flags &^ 2) | 1
			desired.Server = ""
		}
		changes = append(changes, desired)
	}
	return changes, nil
}
