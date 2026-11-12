package main

import (
	"context"
	"encoding/json"
	"net/url"
	"reflect"
	"testing"
)

// site makes a client whose sites answer from routes (exact URL): a string is an HTML body, a json.RawMessage
// is JSON, a func(Req) any answers by the request; anything else is 404. It returns the requests made.
func site(routes map[string]any) (*Client, *[]Req) {
	calls := &[]Req{}
	r := &route{name: "direct", send: func(_ context.Context, _ *route, q Req) (*Resp, error) {
		*calls = append(*calls, q)
		v := routes[q.URL]
		if f, isF := v.(func(Req) any); isF {
			v = f(q)
		}
		switch b := v.(type) {
		case string:
			return &Resp{Status: 200, Type: "text/html", URL: q.URL, Body: []byte(b)}, nil
		case json.RawMessage:
			return &Resp{Status: 200, Type: "application/json", URL: q.URL, Body: b}, nil
		case *Resp:
			return b, nil
		}
		return &Resp{Status: 404, Type: "text/plain", URL: q.URL, Body: []byte("not found")}, nil
	}}
	return &Client{direct: r}, calls
}

func listing(t *testing.T, c *Client, src *Source, raw, cursor string) *Listing {
	t.Helper()
	l, err := listErr(c, src, raw, cursor)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func listErr(c *Client, src *Source, raw, cursor string) (*Listing, error) {
	u, _ := url.Parse(raw)
	return src.Fetch(context.Background(), c, u, ListReq{URL: raw, Cursor: cursor, Limits: defaultLimits})
}

func urls(items []Item) []string {
	out := []string{}
	for _, i := range items {
		out = append(out, i.URL+i.Page)
	}
	return out
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %#v\nwant %#v", got, want)
	}
}

// has checks that v (as JSON) has all fields of the JSON object want, deeply (like toMatchObject).
func has(t *testing.T, v any, want string) {
	t.Helper()
	var g, w any
	b, _ := json.Marshal(v)
	_ = json.Unmarshal(b, &g)
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	if !subset(w, g) {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
}

func subset(want, got any) bool {
	if wm, ok := want.(map[string]any); ok {
		gm, ok := got.(map[string]any)
		if !ok {
			return false
		}
		for k, v := range wm {
			if !subset(v, gm[k]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(want, got)
}

func title(l *Listing) string {
	if l.Title == nil {
		return "<nil>"
	}
	return *l.Title
}
