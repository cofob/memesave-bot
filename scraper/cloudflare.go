package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"time"

	http "github.com/bogdanfinn/fhttp"
	"github.com/chromedp/cdproto/browser"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
	"golang.org/x/sync/singleflight"
)

// Challenge solving: a headless Chromium opens the page through the same proxy as the route. Most challenges
// pass by themselves; when a Turnstile widget stays, NoCaptchaAI solves it and the token goes to its callback.
// The cookies (cf_clearance) and the User-Agent of the browser then go to the route: Cloudflare binds them to
// the IP and the User-Agent.

const (
	solveMax  = 90 * time.Second
	tokenWait = 8 * time.Second // the time a challenge may pass by itself before NoCaptchaAI
)

// hook keeps the options of turnstile.render (sitekey, callback) in window.__ts.
const hook = `(() => {
  let t;
  Object.defineProperty(window, "turnstile", { configurable: true, get: () => t, set(v) {
    t = v;
    if (v && v.render && !v.__hooked) {
      const render = v.render;
      v.render = (el, o) => { window.__ts = o; return render.call(v, el, o); };
      v.__hooked = true;
    }
  }});
})();`

type solver struct {
	chrome string // Chromium binary
	key    string // NoCaptchaAI key; "" = no token
	slots  chan struct{}
	group  singleflight.Group
}

func newSolver(chrome, key string, browsers int) *solver {
	return &solver{chrome: chrome, key: key, slots: make(chan struct{}, max(browsers, 1))}
}

// solve passes the challenge of page for the route; concurrent calls of one route and host wait for one browser.
func (s *solver) solve(ctx context.Context, r *route, pageURL string) error {
	u, err := url.Parse(pageURL)
	if err != nil {
		return err
	}
	_, err, _ = s.group.Do(r.name+"|"+u.Host, func() (any, error) {
		select {
		case s.slots <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		defer func() { <-s.slots }()
		start := time.Now()
		err := s.run(context.WithoutCancel(ctx), r, u) // shared by the waiting requests: not stopped by the first one
		log.Printf("challenge %s via %s: %v in %s", u.Host, r.name, errOr(err), time.Since(start).Round(time.Second))
		return nil, err
	})
	return err
}

func errOr(err error) any {
	if err == nil {
		return "solved"
	}
	return err
}

func (s *solver) run(ctx context.Context, r *route, u *url.URL) error {
	ctx, cancel := context.WithTimeout(ctx, solveMax)
	defer cancel()
	dir, err := os.MkdirTemp("", "chrome")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(s.chrome),
		chromedp.UserDataDir(dir),
		chromedp.WindowSize(1366, 768),
		chromedp.Flag("enable-automation", false),
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.Flag("no-sandbox", true), // the container has no user namespaces
		chromedp.Flag("lang", "en-US"),
	)
	if r.proxy != nil {
		addr, stop, err := tunnel(r.proxy)
		if err != nil {
			return err
		}
		defer stop()
		opts = append(opts, chromedp.ProxyServer("http://"+addr))
	}
	actx, acancel := chromedp.NewExecAllocator(ctx, opts...)
	defer acancel()
	bctx, bcancel := chromedp.NewContext(actx)
	defer bcancel()

	v, err := chromedp.CallBrowser(bctx, browser.GetVersion, struct{}{})
	if err != nil {
		return fmt.Errorf("chromium: %w", err)
	}
	ua := strings.Replace(v.UserAgent, "HeadlessChrome", "Chrome", 1)
	if _, err := chromedp.Call(bctx, emulation.SetUserAgentOverride, emulation.SetUserAgentOverrideParams{UserAgent: ua, AcceptLanguage: "en-US,en;q=0.9"}); err != nil {
		return err
	}
	if _, err := chromedp.Call(bctx, page.AddScriptToEvaluateOnNewDocument, page.AddScriptToEvaluateOnNewDocumentParams{Source: hook}); err != nil {
		return err
	}
	if err := chromedp.Do(bctx, chromedp.Navigate(u.String())); err != nil {
		return err
	}
	asked := false
	for start := time.Now(); ; {
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return errors.New("not solved in time")
		}
		got, err := chromedp.Call(bctx, network.GetCookies, network.GetCookiesParams{URLs: []string{u.String()}})
		if err != nil {
			return err
		}
		title, _ := chromedp.Run(bctx, chromedp.Title())
		// cf_clearance comes before the page reloads, and may come for a challenge that goes on: done on the page itself
		if (clearance(got.Cookies) || time.Since(start) > 3*time.Second) && !waiting(title) {
			r.clear(u, cookies(got.Cookies), ua)
			return nil
		}
		if !asked && s.key != "" && time.Since(start) > tokenWait {
			sitekey, _ := chromedp.Run(bctx, chromedp.Evaluate[string](`window.__ts?.sitekey ?? ""`))
			if sitekey == "" {
				continue
			}
			asked = true
			token, err := turnstile(ctx, s.key, u.String(), sitekey)
			if err != nil {
				return err
			}
			if _, err := chromedp.Run(bctx, chromedp.Evaluate[any](fmt.Sprintf(`window.__ts.callback(%q)`, token))); err != nil {
				return err
			}
		}
	}
}

// waiting: the title of a challenge page.
func waiting(title string) bool {
	t := strings.ToLower(title)
	return strings.Contains(t, "just a moment") || strings.Contains(t, "ddos-guard") || strings.Contains(t, "attention required") || t == ""
}

func clearance(cs []*network.Cookie) bool {
	for _, c := range cs {
		if c.Name == "cf_clearance" {
			return true
		}
	}
	return false
}

func cookies(cs []*network.Cookie) []*http.Cookie {
	out := make([]*http.Cookie, len(cs))
	for i, c := range cs {
		out[i] = &http.Cookie{Name: c.Name, Value: c.Value, Domain: c.Domain, Path: c.Path, Secure: c.Secure, HttpOnly: c.HTTPOnly}
		if c.Expires > 0 {
			out[i].Expires = time.Unix(int64(c.Expires), 0)
		}
	}
	return out
}
