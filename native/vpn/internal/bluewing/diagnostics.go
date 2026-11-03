package bluewing

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"
)

const diagnosticBodyLimit = 256 * 1024

// Capture only bytes consumed by the real HTTP exchange; never eagerly read a streaming body.
type capturedBody struct {
	io.ReadCloser
	mu        sync.Mutex
	data      []byte
	truncated bool
	finish    func()
	once      sync.Once
}

func (b *capturedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.mu.Lock()
	remaining := diagnosticBodyLimit - len(b.data)
	if n > remaining {
		b.truncated = true
	}
	if remaining > n {
		remaining = n
	}
	b.data = append(b.data, p[:remaining]...)
	b.mu.Unlock()
	if err != nil && b.finish != nil {
		b.once.Do(b.finish)
	}
	return n, err
}
func (b *capturedBody) snapshot() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data), b.truncated
}
func (b *capturedBody) Close() error {
	err := b.ReadCloser.Close()
	if b.finish != nil {
		b.once.Do(b.finish)
	}
	return err
}
func (t contextTransport) roundTrip(r *http.Request) (*http.Response, error) {
	// Keep the caller's deadline/values as well as cancellation of the owning VPN session.
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(t.ctx, cancel)
	if t.ctx.Err() != nil {
		cancel()
	}
	cleanup := func() { stop(); cancel() }
	request := r.Clone(ctx)
	started := time.Now()
	entry := map[string]any{"stage": r.URL.Path, "method": r.Method, "url": r.URL.Scheme + "://" + r.URL.Host + r.URL.Path}
	var sent *capturedBody
	if t.trace != nil && t.full {
		entry["url"], entry["requestHeaders"] = r.URL.String(), r.Header.Clone()
		if r.Body != nil {
			sent = &capturedBody{ReadCloser: r.Body}
			request.Body = sent
		}
	}
	resp, err := t.inner.RoundTrip(request)
	emit := func() {
		if t.trace == nil {
			return
		}
		entry["durationMs"] = time.Since(started).Milliseconds()
		if sent != nil {
			entry["requestBody"], entry["requestBodyTruncated"] = sent.snapshot()
		}
		t.trace(entry)
	}
	if err != nil {
		cleanup()
		entry["error"] = "HTTP exchange failed" // net errors can embed credential-bearing URLs.
		emit()
		return resp, err
	}
	entry["status"] = resp.StatusCode
	if t.full {
		entry["responseHeaders"] = resp.Header.Clone()
	}
	if resp.Body == nil {
		cleanup()
		emit()
		return resp, nil
	}
	body := &capturedBody{ReadCloser: resp.Body}
	body.finish = func() {
		cleanup()
		if t.full {
			entry["responseBody"], entry["responseBodyTruncated"] = body.snapshot()
		}
		emit()
	}
	resp.Body = body
	return resp, nil
}
