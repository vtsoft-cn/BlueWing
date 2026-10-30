//go:build !windows

package winproxy

import "errors"

func InstallRecovery(string, int) error { return errors.New("Windows only") }
func WatchRecovery(string, int) error   { return errors.New("Windows only") }
