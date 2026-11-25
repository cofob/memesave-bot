// Scraper: the gallery sources of memesave (Telegraph, e621, Hentoid sites) behind one HTTP API, with a proxy
// pool, the Chrome TLS fingerprint and Cloudflare challenge solving (Chromium + NoCaptchaAI). See api.go.
package main

import (
	"cmp"
	"context"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// list splits a comma list, empty values dropped.
func list(s string) []string {
	var out []string
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func main() {
	keys := list(os.Getenv("API_KEYS"))
	if len(keys) == 0 {
		log.Fatal("API_KEYS is not set")
	}
	c, err := newClient(list(os.Getenv("PROXIES")), os.Getenv("DIRECT") != "0")
	if err != nil {
		log.Fatal(err)
	}
	browsers, _ := strconv.Atoi(cmp.Or(os.Getenv("MAX_BROWSERS"), "2"))
	// SOLVER_PROXY: our own IP as a proxy for CapSolver (cf_clearance is bound to the IP), served on PROXY_LISTEN.
	own, err := url.Parse(os.Getenv("SOLVER_PROXY"))
	if err != nil || own.Host == "" {
		own = nil
	} else if addr := os.Getenv("PROXY_LISTEN"); addr != "" {
		pass, _ := own.User.Password()
		go ownProxy(addr, own.User.Username()+":"+pass)
	}
	c.solve = newSolver(cmp.Or(os.Getenv("CHROME_PATH"), "chromium"), os.Getenv("NOCAPTCHA_KEY"), os.Getenv("CAPSOLVER_KEY"), own, browsers).solve
	srv := &http.Server{Addr: ":" + cmp.Or(os.Getenv("PORT"), "8080"), Handler: (&server{c: c, keys: keys}).routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	log.Printf("scraper on %s: %d proxies, direct %v", srv.Addr, len(c.proxies), c.direct != nil)
	// A rollout sends SIGTERM: finish the requests in progress, then exit.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, os.Interrupt)
	<-stop
	_ = srv.Shutdown(context.Background())
}
