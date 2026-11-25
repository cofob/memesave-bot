package main

import (
	"context"
	"errors"
	"net/url"
	"strings"

	http "github.com/bogdanfinn/fhttp"
)

// CapSolver (docs.capsolver.com, AntiCloudflareTask) passes the Cloudflare managed challenge through our proxy and
// returns cf_clearance with the User-Agent it is bound to. cf_clearance is bound to the IP too: the direct route
// needs a proxy that leaves from our own IP (SOLVER_PROXY, served by PROXY_LISTEN).

var capsolverURL = "https://api.capsolver.com"

// capProxy is the proxy u in the CapSolver format scheme:host:port:user:pass.
func capProxy(u *url.URL) string {
	scheme := strings.TrimSuffix(u.Scheme, "h") // socks5h → socks5
	p := []string{scheme, u.Hostname(), u.Port()}
	if u.User != nil {
		pass, _ := u.User.Password()
		p = append(p, u.User.Username(), pass)
	}
	return strings.Join(p, ":")
}

// capsolve returns the cookies (cf_clearance) and the User-Agent of the solved challenge of pageURL via proxy.
func capsolve(ctx context.Context, key, pageURL string, proxy *url.URL, ua string) ([]*http.Cookie, string, error) {
	r, err := task(ctx, capsolverURL, key, map[string]string{"type": "AntiCloudflareTask", "websiteURL": pageURL, "proxy": capProxy(proxy), "userAgent": ua})
	if err != nil {
		return nil, "", err
	}
	if r.Solution.Cookies["cf_clearance"] == "" {
		return nil, "", errors.New("capsolver: no cf_clearance")
	}
	var cs []*http.Cookie
	for k, v := range r.Solution.Cookies {
		cs = append(cs, &http.Cookie{Name: k, Value: v, Path: "/"})
	}
	return cs, r.Solution.UserAgent, nil
}
