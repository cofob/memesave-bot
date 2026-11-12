package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

// fakeRoute answers with the responses in order (the last one again), and counts its requests.
func fakeRoute(name string, n *int, answers ...*Resp) *route {
	return &route{name: name, send: func(_ context.Context, _ *route, q Req) (*Resp, error) {
		i := min(*n, len(answers)-1)
		*n++
		if answers[i] == nil {
			return nil, errors.New("network")
		}
		r := *answers[i]
		r.URL = q.URL
		return &r, nil
	}}
}

var (
	okHTML    = &Resp{Status: 200, Type: "text/html", Body: []byte("<p>ok</p>")}
	cfPage    = &Resp{Status: 403, Type: "text/html; charset=UTF-8", Mitigated: "challenge", Body: []byte("<title>Just a moment...</title>")}
	moment200 = &Resp{Status: 200, Type: "text/html", Body: []byte("<html><title>Just a moment...</title>")}
	limited   = &Resp{Status: 429, Type: "text/plain"}
)

func TestBlocked(t *testing.T) {
	eq(t, challenge(cfPage), true)
	eq(t, challenge(moment200), true)
	eq(t, challenge(&Resp{Status: 403, Type: "text/html", Body: []byte("<script src=/cdn-cgi/challenge-platform/x.js>")}), true)
	eq(t, challenge(&Resp{Status: 200, Type: "text/html", Body: []byte("<script src=/cdn-cgi/challenge-platform/x.js>")}), false) // a normal page with the bot script
	eq(t, challenge(&Resp{Status: 403, Type: "image/png", Body: []byte("just a moment")}), false)
	eq(t, blocked(limited), true)
	eq(t, blocked(&Resp{Status: 404}), false)
	eq(t, blocked(okHTML), false)
}

func TestFetchRoutes(t *testing.T) {
	var d, p1, p2, p3, p4 int
	c := &Client{direct: fakeRoute("direct", &d, limited), proxies: []*route{fakeRoute("p1", &p1, nil), fakeRoute("p2", &p2, limited), fakeRoute("p3", &p3, limited), fakeRoute("p4", &p4, limited)}}
	res, err := c.Fetch(t.Context(), Req{URL: "https://site.test/"})
	eq(t, err, nil)
	eq(t, res.Status, 429) // the last answer
	eq(t, d, 1)
	eq(t, p1+p2+p3+p4, 3) // at most 3 proxies

	d, p1 = 0, 0
	c = &Client{direct: fakeRoute("direct", &d, okHTML), proxies: []*route{fakeRoute("p1", &p1, okHTML)}}
	res, _ = c.Fetch(t.Context(), Req{URL: "https://site.test/"})
	eq(t, string(res.Body), "<p>ok</p>")
	eq(t, p1, 0) // no proxy for a normal answer

	c = &Client{proxies: []*route{fakeRoute("p1", new(int), nil)}}
	if _, err := c.Fetch(t.Context(), Req{URL: "https://site.test/"}); err == nil || err.Error() != "network" {
		t.Fatal(err)
	}
}

func TestFetchSolves(t *testing.T) {
	var n, solved int
	c := &Client{direct: fakeRoute("direct", &n, cfPage, okHTML)}
	c.solve = func(_ context.Context, r *route, page string) error {
		solved++
		eq(t, page, "https://site.test/p")
		return nil
	}
	res, _ := c.Fetch(t.Context(), Req{URL: "https://site.test/p"})
	eq(t, res.Status, 200)
	eq(t, solved, 1)
	eq(t, n, 2)

	var p int
	n, solved = 0, 0
	c = &Client{direct: fakeRoute("direct", &n, cfPage), proxies: []*route{fakeRoute("p1", &p, okHTML)}}
	c.solve = func(context.Context, *route, string) error { solved++; return errors.New("no") }
	res, _ = c.Fetch(t.Context(), Req{URL: "https://site.test/p"})
	eq(t, res.Status, 200) // the proxy passed
	eq(t, [3]int{solved, n, p}, [3]int{1, 1, 1})

	c = &Client{direct: fakeRoute("direct", new(int), cfPage), solve: func(context.Context, *route, string) error { return errors.New("no") }}
	_, err := c.Get(t.Context(), "https://site.test/", nil) // a failed solve keeps the challenge answer
	var se *StatusError
	if !errors.As(err, &se) || !se.Blocked || se.Status != 403 {
		t.Fatal(err)
	}
}

func TestGap(t *testing.T) {
	c := &Client{direct: fakeRoute("direct", new(int), okHTML), gaps: map[string]time.Duration{"e621.net": 50 * time.Millisecond}}
	start := time.Now()
	for range 3 {
		_, _ = c.Fetch(t.Context(), Req{URL: "https://e621.net/posts.json"})
	}
	_, _ = c.Fetch(t.Context(), Req{URL: "https://static1.e621.net/a.jpg"}) // another host: no gap
	if d := time.Since(start); d < 100*time.Millisecond || d > 140*time.Millisecond {
		t.Fatal(d)
	}
}
