package mobile

import "testing"

func TestNormalizeRoutesKeepsPublicTrafficOutsideTunnel(t *testing.T) {
	got, err := NormalizeRoutes("10.20.0.23/16, 10.20.0.0/16\r\n172.31.5.2/32")
	if err != nil || got != "10.20.0.0/16\n172.31.5.2/32" {
		t.Fatalf("NormalizeRoutes() = %q, %v", got, err)
	}
	for _, input := range []string{"", "0.0.0.0/0", "10.0.0.0/7", "172.16.0.0/11", "192.0.0.0/8", "8.8.8.8/32", "::/0"} {
		if _, err := NormalizeRoutes(input); err == nil {
			t.Errorf("accepted route %q", input)
		}
	}
}
