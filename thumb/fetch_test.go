package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchThroughProxy(t *testing.T) {
	// The "proxy" answers any request itself and shows the URL it was asked for.
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusTeapot)
		io.WriteString(w, r.URL.String()+" "+r.Header.Get("X-Test"))
	}))
	defer proxy.Close()
	body := `{"url":"http://upstream.test/a","headers":{"X-Test":"1"},"proxy":"` + proxy.URL + `"}`
	rec := httptest.NewRecorder()
	fetch(rec, httptest.NewRequest("POST", "/fetch", strings.NewReader(body)))
	if rec.Code != http.StatusTeapot || rec.Body.String() != "http://upstream.test/a 1" || rec.Header().Get("Content-Type") != "text/plain" {
		t.Fatal(rec.Code, rec.Body.String(), rec.Header())
	}
}

func TestFetchBadProxy(t *testing.T) {
	rec := httptest.NewRecorder()
	fetch(rec, httptest.NewRequest("POST", "/fetch", strings.NewReader(`{"url":"http://x.test/","proxy":"http://127.0.0.1:1"}`)))
	if rec.Code != http.StatusBadGateway {
		t.Fatal(rec.Code)
	}
}
