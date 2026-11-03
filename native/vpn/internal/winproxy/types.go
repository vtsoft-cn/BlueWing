package winproxy

import (
	"encoding/json"
	"io"
)

type Connection struct {
	Name   string `json:"name"`
	Flags  uint32 `json:"flags"`
	Server string `json:"server"`
	Bypass string `json:"bypass"`
	PAC    string `json:"pac"`
}
type Request struct {
	Action         string       `json:"action"`
	Server         string       `json:"server"`
	Bypass         string       `json:"bypass"`
	Connections    []Connection `json:"connections"`
	ManagedServer  string       `json:"managedServer"`
	ManagedServers []string     `json:"managedServers,omitempty"`
	OwnershipFile  string       `json:"ownershipFile"`
	ParentPID      int          `json:"parentPid"`
}
type Response struct {
	OK          bool         `json:"ok"`
	Connections []Connection `json:"connections,omitempty"`
	Error       string       `json:"error,omitempty"`
}

func Run(in io.Reader, out io.Writer) {
	var req Request
	if json.NewDecoder(io.LimitReader(in, 1024*1024)).Decode(&req) != nil {
		_ = json.NewEncoder(out).Encode(Response{Error: "invalid request"})
		return
	}
	result, err := execute(req)
	if err != nil {
		_ = json.NewEncoder(out).Encode(Response{Error: err.Error()})
		return
	}
	_ = json.NewEncoder(out).Encode(Response{OK: true, Connections: result})
}
