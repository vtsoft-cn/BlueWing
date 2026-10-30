package winproxy

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

var wininet = windows.NewLazySystemDLL("wininet.dll")
var queryOption = wininet.NewProc("InternetQueryOptionW")
var setOption = wininet.NewProc("InternetSetOptionW")
var globalFree = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalFree")
var rasEnum = windows.NewLazySystemDLL("rasapi32.dll").NewProc("RasEnumEntriesW")

type option struct {
	Kind  uint32
	Value uintptr
}
type optionList struct {
	Size       uint32
	Connection *uint16
	Count      uint32
	Error      uint32
	Options    *option
}
type rasEntry struct {
	Size      uint32
	Name      [257]uint16
	Flags     uint32
	Phonebook [261]uint16
}

func names() ([]string, error) {
	result := []string{""}
	var count uint32
	size := uint32(unsafe.Sizeof(rasEntry{}))
	entries := make([]rasEntry, 1)
	entries[0].Size = size
	code, _, _ := rasEnum.Call(0, 0, uintptr(unsafe.Pointer(&entries[0])), uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)))
	if code == 603 {
		entries = make([]rasEntry, int(size)/int(unsafe.Sizeof(rasEntry{}))+1)
		entries[0].Size = uint32(unsafe.Sizeof(rasEntry{}))
		code, _, _ = rasEnum.Call(0, 0, uintptr(unsafe.Pointer(&entries[0])), uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)))
	}
	if code != 0 {
		return nil, fmt.Errorf("RasEnumEntries: %d", code)
	}
	for i := 0; i < int(count); i++ {
		result = append(result, windows.UTF16ToString(entries[i].Name[:]))
	}
	return result, nil
}
func query(name string) (Connection, error) {
	result := Connection{Name: name}
	var connection *uint16
	var err error
	if name != "" {
		connection, err = windows.UTF16PtrFromString(name)
		if err != nil {
			return result, err
		}
	}
	options := []option{{Kind: 10}, {Kind: 2}, {Kind: 3}, {Kind: 4}}
	list := optionList{Size: uint32(unsafe.Sizeof(optionList{})), Connection: connection, Count: uint32(len(options)), Options: &options[0]}
	size := list.Size
	ok, _, callErr := queryOption.Call(0, 75, uintptr(unsafe.Pointer(&list)), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return result, fmt.Errorf("InternetQueryOption: %w", callErr)
	}
	defer func() {
		for _, o := range options[1:] {
			if o.Value != 0 {
				globalFree.Call(o.Value)
			}
		}
	}()
	result.Flags = uint32(options[0].Value)
	text := func(ptr uintptr) string {
		if ptr == 0 {
			return ""
		}
		return windows.UTF16PtrToString((*uint16)(unsafe.Pointer(ptr)))
	}
	result.Server = text(options[1].Value)
	result.Bypass = text(options[2].Value)
	result.PAC = text(options[3].Value)
	return result, nil
}
func write(c Connection) error {
	var name *uint16
	var err error
	if c.Name != "" {
		name, err = windows.UTF16PtrFromString(c.Name)
		if err != nil {
			return err
		}
	}
	server, err := windows.UTF16PtrFromString(c.Server)
	if err != nil {
		return err
	}
	bypass, err := windows.UTF16PtrFromString(c.Bypass)
	if err != nil {
		return err
	}
	pac, err := windows.UTF16PtrFromString(c.PAC)
	if err != nil {
		return err
	}
	options := []option{{Kind: 1, Value: uintptr(c.Flags)}, {Kind: 2, Value: uintptr(unsafe.Pointer(server))}, {Kind: 3, Value: uintptr(unsafe.Pointer(bypass))}, {Kind: 4, Value: uintptr(unsafe.Pointer(pac))}}
	list := optionList{Size: uint32(unsafe.Sizeof(optionList{})), Connection: name, Count: uint32(len(options)), Options: &options[0]}
	ok, _, callErr := setOption.Call(0, 75, uintptr(unsafe.Pointer(&list)), uintptr(list.Size))
	runtime.KeepAlive(server)
	runtime.KeepAlive(bypass)
	runtime.KeepAlive(pac)
	runtime.KeepAlive(name)
	if ok == 0 {
		return fmt.Errorf("InternetSetOption: %w", callErr)
	}
	return nil
}
func execute(req Request) ([]Connection, error) {
	if req.Action == "guard" {
		return nil, InstallRecovery(req.OwnershipFile, req.ParentPID)
	}
	ns, err := names()
	if err != nil {
		return nil, err
	}
	before := []Connection{}
	for _, name := range ns {
		value, e := query(name)
		if e != nil {
			return nil, e
		}
		before = append(before, value)
	}
	if req.Action == "query" {
		return before, nil
	}
	changes := []Connection{}
	switch req.Action {
	case "enable":
		for _, v := range before {
			changes = append(changes, Connection{Name: v.Name, Flags: 3, Server: req.Server, Bypass: req.Bypass})
		}
	case "disable":
		for _, v := range before {
			if v.Server == req.ManagedServer {
				v.Flags = 1
				v.Server = ""
				v.PAC = ""
				changes = append(changes, v)
			}
		}
	case "restore":
		for _, desired := range req.Connections {
			for _, v := range before {
				if v.Name == desired.Name && (v.Server == req.ManagedServer || req.ManagedServer == "") {
					changes = append(changes, desired)
				}
			}
		}
	default:
		return nil, errors.New("unsupported action")
	}
	for _, v := range changes {
		if err = write(v); err != nil {
			for _, old := range before {
				_ = write(old)
			}
			return nil, err
		}
	}
	setOption.Call(0, 39, 0, 0)
	setOption.Call(0, 37, 0, 0)
	after := []Connection{}
	for _, name := range ns {
		v, e := query(name)
		if e != nil {
			return nil, e
		}
		after = append(after, v)
	}
	for _, want := range changes {
		for _, got := range after {
			if want.Name == got.Name && (want.Flags != got.Flags || want.Server != got.Server || want.Bypass != got.Bypass || want.PAC != got.PAC) {
				for _, old := range before {
					_ = write(old)
				}
				return nil, errors.New("WinINet readback mismatch")
			}
		}
	}
	return after, nil
}
