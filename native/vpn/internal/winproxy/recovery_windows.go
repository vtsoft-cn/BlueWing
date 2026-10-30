package winproxy

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func InstallRecovery(file string, pid int) error {
	if !filepath.IsAbs(file) || pid <= 0 {
		return fmt.Errorf("invalid recovery owner")
	}
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	key, _, e := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if e != nil {
		return e
	}
	defer key.Close()
	if e = key.SetStringValue("BlueWing Network Recovery", fmt.Sprintf("\"%s\" --recover-network \"%s\"", exe, file)); e != nil {
		return e
	}
	watch := exec.Command(exe, "--watch-network", file, strconv.Itoa(pid))
	watch.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if e = watch.Start(); e != nil {
		return e
	}
	return watch.Process.Release()
}

func WatchRecovery(file string, pid int) error {
	handle, e := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if e == nil {
		_, e = windows.WaitForSingleObject(handle, windows.INFINITE)
		_ = windows.CloseHandle(handle)
		if e != nil {
			return e
		}
	}
	return RecoverNetwork(file)
}
