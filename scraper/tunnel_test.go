package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// TestTunnel: a CONNECT through the local tunnel and an upstream http proxy with a password reaches the site.
func TestTunnel(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hello")) }))
	defer site.Close()
	auth := ""
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { // a CONNECT proxy
		auth = r.Header.Get("Proxy-Authorization")
		dst, err := net.Dial("tcp", r.Host)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		src, buf, _ := w.(http.Hijacker).Hijack()
		_, _ = io.WriteString(src, "HTTP/1.1 200 OK\r\n\r\n")
		go func() { _, _ = io.Copy(dst, buf) }()
		_, _ = io.Copy(src, dst)
		src.Close()
	}))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	u.User = url.UserPassword("ann", "secret")

	addr, stop, err := tunnel(u)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	target := site.Listener.Addr().String()
	_, _ = io.WriteString(conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n")
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, nil)
	if err != nil || res.StatusCode != 200 {
		t.Fatal(res, err)
	}
	_, _ = io.WriteString(conn, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	res, err = http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	eq(t, string(body), "hello")
	eq(t, auth, "Basic YW5uOnNlY3JldA==")
}
