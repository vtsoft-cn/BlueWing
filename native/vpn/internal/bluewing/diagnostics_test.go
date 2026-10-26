package bluewing

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDiagnosticBodiesPreservedAndExplicitlyOptedIn(t *testing.T) {
	const payload = `{"otp":"123456","password":"example-secret"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if string(b) != payload {
			t.Error("request body changed")
		}
		w.Header().Set("Set-Cookie", "sid=original-cookie")
		_, _ = io.WriteString(w, `{"code":75500503,"message":"original-message"}`)
	}))
	defer server.Close()
	for _, full := range []bool{false, true} {
		var entries []map[string]any
		Configure(context.Background(), Policy{}, func(string, string, []byte) (string, error) { return "", nil })
		SetDiagnostics(func(d map[string]any) { entries = append(entries, d) }, full)
		tr := Transport(http.DefaultTransport)
		req, _ := http.NewRequest("POST", server.URL+"/auth?sid=original", strings.NewReader(payload))
		resp, err := tr.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if !strings.Contains(string(body), "75500503") || len(entries) != 1 {
			t.Fatal("response or trace altered", entries)
		}
		d := entries[0]
		if full {
			if d["requestBody"] != payload || d["responseBody"] != string(body) || !strings.Contains(d["url"].(string), "sid=original") {
				t.Fatal("raw content lost", d)
			}
			if d["responseHeaders"].(http.Header).Get("Set-Cookie") != "sid=original-cookie" {
				t.Fatal("cookie lost")
			}
		} else if d["requestBody"] != nil || d["responseBody"] != nil || d["responseHeaders"] != nil || strings.Contains(d["url"].(string), "sid=") {
			t.Fatal("basic mode logged credential content", d)
		}
	}
	SetDiagnostics(nil, false)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestTransportRetainsCallerDeadlineAndValues(t *testing.T) {
	type key struct{}
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), key{}, "value"), 20*time.Millisecond)
	defer cancel()
	Configure(context.Background(), Policy{}, func(string, string, []byte) (string, error) { return "", nil })
	SetDiagnostics(nil, false)
	tr := Transport(roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Context().Value(key{}) != "value" {
			t.Error("caller context lost")
		}
		select {
		case <-r.Context().Done():
			return nil, r.Context().Err()
		case <-time.After(time.Second):
			t.Error("caller timeout ignored")
			return nil, context.DeadlineExceeded
		}
	}))
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://example.invalid", nil)
	if _, err := tr.RoundTrip(req); err == nil {
		t.Fatal("deadline ignored")
	}
}
func TestCaptureIsBounded(t *testing.T) {
	b := &capturedBody{ReadCloser: io.NopCloser(strings.NewReader(strings.Repeat("x", diagnosticBodyLimit+100)))}
	all, err := io.ReadAll(b)
	text, truncated := b.snapshot()
	if err != nil || len(all) != diagnosticBodyLimit+100 || len(text) != diagnosticBodyLimit || !truncated {
		t.Fatal("capture changed stream or grew unbounded")
	}
}
