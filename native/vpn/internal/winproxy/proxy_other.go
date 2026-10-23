//go:build !windows

package winproxy

import "errors"

func execute(req Request) ([]Connection, error) { return nil, errors.New("Windows only") }
