package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const (
	maxBody   = 50 << 20
	tries     = 3 // proxies per request
	defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
)

// Req is a request to a site (also the body of POST /fetch).
type Req struct {
	URL     string            `json:"url"`
	Method  string            `json:"method,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

// Resp is the buffered answer of a site.
type Resp struct {
	Status    int
	Type      string // Content-Type
	URL       string // after redirects
	Mitigated string // cf-mitigated
	Size      int64  // Content-Length, -1 when unknown
	Body      []byte
}

func (r *Resp) ok() bool { return r.Status >= 200 && r.Status < 300 }

// StatusError: the site answered a status that is not 2xx.
type StatusError struct {
	Status  int
	URL     string
	Blocked bool // a challenge that was not solved
}

func (e *StatusError) Error() string { return fmt.Sprintf("%d %s", e.Status, e.URL) }

// route is one way out: direct or one proxy, with its own TLS client, cookies and User-Agent.
type route struct {
	name  string   // "direct" or the proxy URL without the password
	proxy *url.URL // nil: direct
	hc    tls_client.HttpClient
	mu    sync.Mutex
	ua    string
	send  func(ctx context.Context, r *route, q Req) (*Resp, error)
}

var idle = 30 * time.Second

func newRoute(proxy string) (*route, error) {
	r := &route{name: "direct", ua: defaultUA, send: sendTLS}
	opts := []tls_client.HttpClientOption{
		tls_client.WithClientProfile(profiles.Chrome_154),
		tls_client.WithTimeoutSeconds(60),
		tls_client.WithCookieJar(tls_client.NewCookieJar()),
		tls_client.WithDisableHttp3(),
		// The NAT of the host drops idle connections: no reuse of old ones, and a PING finds dead HTTP/2 ones
		tls_client.WithTransportOptions(&tls_client.TransportOptions{IdleConnTimeout: &idle, ReadIdleTimeout: 15 * time.Second, PingTimeout: 5 * time.Second, ResponseHeaderTimeout: 30 * time.Second}),
	}
	if proxy != "" {
		u, err := url.Parse(proxy)
		if err != nil {
			return nil, err
		}
		r.proxy, r.name = u, u.Redacted()
		opts = append(opts, tls_client.WithProxyUrl(proxy))
	} else { // a host that does not answer fails fast (tls-client sets the timeout of its own dialer to the request timeout)
		d := &net.Dialer{Timeout: 10 * time.Second}
		opts = append(opts, tls_client.WithDialContext(d.DialContext))
	}
	hc, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), opts...)
	r.hc = hc
	return r, err
}

func (r *route) userAgent() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ua
}

// clear takes the cookies and the User-Agent of a solved challenge.
func (r *route) clear(page *url.URL, cookies []*http.Cookie, ua string) {
	r.hc.SetCookies(page, cookies)
	r.mu.Lock()
	r.ua = ua
	r.mu.Unlock()
}

var headerOrder = []string{"user-agent", "accept", "accept-language", "referer", "cookie", "authorization", "content-type"}

func sendTLS(ctx context.Context, r *route, q Req) (*Resp, error) {
	method := q.Method
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, q.URL, strings.NewReader(q.Body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", r.userAgent())
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	for k, v := range q.Headers {
		req.Header.Set(k, v)
	}
	req.Header[http.HeaderOrderKey] = headerOrder
	res, err := r.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err == nil && len(body) > maxBody {
		err = fmt.Errorf("body over %d bytes: %s", maxBody, q.URL)
	}
	if err != nil {
		return nil, err
	}
	return &Resp{Status: res.StatusCode, Type: res.Header.Get("Content-Type"), URL: res.Request.URL.String(), Mitigated: res.Header.Get("cf-mitigated"), Size: res.ContentLength, Body: body}, nil
}

// challenge: a Cloudflare or DDoS-Guard challenge page that a browser can pass.
func challenge(r *Resp) bool {
	if r.Mitigated == "challenge" {
		return true
	}
	if !strings.Contains(r.Type, "text/html") {
		return false
	}
	b := bytes.ToLower(r.Body[:min(len(r.Body), 64<<10)])
	return bytes.Contains(b, []byte("just a moment")) || (r.Status == 403 || r.Status == 503) && (bytes.Contains(b, []byte("challenge-platform")) || bytes.Contains(b, []byte("ddos-guard")))
}

// blocked: the site blocked us (challenge, rate limit, geo block); another route may pass.
func blocked(r *Resp) bool {
	return r.Status == 403 || r.Status == 429 || r.Status == 503 || challenge(r)
}

// Client makes the requests to the sites: direct first (if allowed), then up to 3 random proxies.
type Client struct {
	direct  *route
	proxies []*route
	solve   func(ctx context.Context, r *route, page string) error // nil: challenges are not solved
	gaps    map[string]time.Duration                               // minimal time between requests to a host
	mu      sync.Mutex
	free    map[string]time.Time
}

func newClient(proxies []string, direct bool) (*Client, error) {
	c := &Client{gaps: map[string]time.Duration{"e621.net": 500 * time.Millisecond, "rule34.xxx": time.Second, "gelbooru.com": 500 * time.Millisecond}} // e621 allows 2 requests per second
	if direct || len(proxies) == 0 {
		r, err := newRoute("")
		if err != nil {
			return nil, err
		}
		c.direct = r
	}
	for _, p := range proxies {
		r, err := newRoute(p)
		if err != nil {
			return nil, fmt.Errorf("proxy %d: %w", len(c.proxies)+1, err)
		}
		c.proxies = append(c.proxies, r)
	}
	return c, nil
}

func (c *Client) routes() []*route {
	var out []*route
	if c.direct != nil {
		out = append(out, c.direct)
	}
	ps := append([]*route(nil), c.proxies...)
	rand.Shuffle(len(ps), func(i, j int) { ps[i], ps[j] = ps[j], ps[i] })
	return append(out, ps[:min(len(ps), tries)]...)
}

// wait keeps the gap of the host between requests.
func (c *Client) wait(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	gap := c.gaps[u.Hostname()]
	if gap == 0 {
		return nil
	}
	c.mu.Lock()
	if c.free == nil {
		c.free = map[string]time.Time{}
	}
	at := time.Now()
	if f := c.free[u.Hostname()]; f.After(at) {
		at = f
	}
	c.free[u.Hostname()] = at.Add(gap)
	c.mu.Unlock()
	select {
	case <-time.After(time.Until(at)):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Fetch makes the request; on a challenge it is solved once per route, when blocked the next route tries.
// The last answer is returned even when it is blocked.
func (c *Client) Fetch(ctx context.Context, q Req) (*Resp, error) {
	if err := c.wait(ctx, q.URL); err != nil {
		return nil, err
	}
	var last *Resp
	err := errors.New("no routes")
	for _, r := range c.routes() {
		res, e := r.send(ctx, r, q)
		if e == nil && challenge(res) && c.solve != nil && c.solve(ctx, r, q.URL) == nil { // the solver logs a failure
			res, e = r.send(ctx, r, q)
		}
		if e != nil {
			err = e
			continue
		}
		last = res
		if !blocked(res) {
			return res, nil
		}
	}
	if last != nil {
		return last, nil
	}
	return nil, err
}

// Get is a GET that fails on a status that is not 2xx.
func (c *Client) Get(ctx context.Context, url string, h map[string]string) (*Resp, error) {
	return c.must(c.Fetch(ctx, Req{URL: url, Headers: h}))
}

func (c *Client) must(res *Resp, err error) (*Resp, error) {
	if err == nil && !res.ok() {
		err = &StatusError{Status: res.Status, URL: res.URL, Blocked: challenge(res)}
	}
	if err != nil {
		return nil, err
	}
	return res, nil
}

// Text is the body of a GET.
func (c *Client) Text(ctx context.Context, url string, h map[string]string) (string, error) {
	res, err := c.Get(ctx, url, h)
	if err != nil {
		return "", err
	}
	return string(res.Body), nil
}

// JSON decodes the body of a GET into v and returns the raw body.
func (c *Client) JSON(ctx context.Context, url string, h map[string]string, v any) ([]byte, error) {
	res, err := c.Get(ctx, url, h)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(res.Body, v); err != nil {
		return nil, fmt.Errorf("%s: %w", url, err)
	}
	return res.Body, nil
}
