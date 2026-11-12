package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/net/proxy"
)

// A local CONNECT proxy for the browser that dials through the upstream proxy of a route (http, https or
// socks5, with auth): Chromium has no socks5 auth and needs CDP for http auth otherwise.

type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// upstream returns the dialer of the proxy URL.
func upstream(u *url.URL) (dialFunc, error) {
	switch u.Scheme {
	case "socks5", "socks5h":
		d, err := proxy.FromURL(u, &net.Dialer{Timeout: 30 * time.Second})
		if err != nil {
			return nil, err
		}
		return d.(proxy.ContextDialer).DialContext, nil
	case "http", "https":
		return func(ctx context.Context, network, addr string) (net.Conn, error) { return connect(ctx, u, addr) }, nil
	}
	return nil, fmt.Errorf("proxy scheme %q", u.Scheme)
}

// connect opens a tunnel to addr through the http(s) proxy u.
func connect(ctx context.Context, u *url.URL, addr string) (net.Conn, error) {
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), map[string]string{"http": "80", "https": "443"}[u.Scheme])
	}
	d := &net.Dialer{Timeout: 30 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "https" {
		tc := tls.Client(conn, &tls.Config{ServerName: u.Hostname()})
		if err := tc.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		conn = tc
	}
	req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", addr, addr)
	if u.User != nil {
		pass, _ := u.User.Password()
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(u.User.Username()+":"+pass)) + "\r\n"
	}
	if _, err := io.WriteString(conn, req+"\r\n"); err != nil {
		conn.Close()
		return nil, err
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), nil) // the proxy sends nothing more before the client's data
	if err == nil && res.StatusCode != http.StatusOK {
		err = fmt.Errorf("proxy CONNECT: %s", res.Status)
	}
	if err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// tunnel starts the local proxy to the upstream u and returns its address and the stop function.
func tunnel(u *url.URL) (string, func(), error) {
	dial, err := upstream(u)
	if err != nil {
		return "", nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT only", http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		dst, err := dial(ctx, "tcp", r.Host)
		cancel()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		src, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			dst.Close()
			return
		}
		_, _ = io.WriteString(src, "HTTP/1.1 200 Connection established\r\n\r\n")
		go func() { _, _ = io.Copy(dst, buf); dst.Close() }()
		_, _ = io.Copy(src, dst)
		src.Close()
	})}
	go func() { _ = srv.Serve(ln) }()
	return ln.Addr().String(), func() { _ = srv.Close() }, nil
}
