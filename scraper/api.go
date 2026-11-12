package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
)

// HTTP API: POST / (a listing step), POST /media (an image of a listing), POST /fetch (a raw request), GET /health.
// All but /health need "Authorization: Api-Key <key>".

var defaultLimits = Limits{Photo: 10 << 20, Animation: 50 << 20, Video: 50 << 20} // Bot API send limits

type server struct {
	c    *Client
	keys []string
}

func (s *server) routes() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	m.HandleFunc("POST /{$}", s.auth(s.list))
	m.HandleFunc("POST /media", s.auth(s.media))
	m.HandleFunc("POST /fetch", s.auth(s.fetch))
	return m
}

func (s *server) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Api-Key ")
		for _, k := range s.keys {
			if ok && subtle.ConstantTimeCompare([]byte(key), []byte(k)) == 1 {
				h(w, r)
				return
			}
		}
		fail(w, http.StatusUnauthorized, "unauthorized", 0)
	}
}

// fail answers {"error":{"code","status"}}; status is the status of the site, if any.
func fail(w http.ResponseWriter, code int, name string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": name, "status": status}})
}

func failErr(w http.ResponseWriter, err error) {
	var se *StatusError
	switch {
	case errors.As(err, &se) && se.Blocked:
		fail(w, http.StatusBadGateway, "blocked", se.Status)
	case errors.As(err, &se):
		fail(w, http.StatusBadGateway, "upstream", se.Status)
	default:
		log.Print(err)
		fail(w, http.StatusBadGateway, "upstream", 0)
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		fail(w, http.StatusBadRequest, "bad_request", 0)
		return false
	}
	return true
}

// pass answers the site's status, Content-Type and body.
func pass(w http.ResponseWriter, res *Resp) {
	if res.Type != "" {
		w.Header().Set("Content-Type", res.Type)
	}
	w.WriteHeader(res.Status)
	_, _ = w.Write(res.Body)
}

func (s *server) list(w http.ResponseWriter, r *http.Request) {
	var q ListReq
	if !decode(w, r, &q) {
		return
	}
	u, err := url.Parse(q.URL)
	if err != nil || u.Host == "" {
		fail(w, http.StatusBadRequest, "bad_request", 0)
		return
	}
	src := sourceOf(u)
	if src == nil {
		fail(w, http.StatusBadRequest, "unsupported", 0)
		return
	}
	if q.Limits == (Limits{}) {
		q.Limits = defaultLimits
	}
	l, err := src.Fetch(r.Context(), s.c, u, q)
	if err != nil {
		log.Printf("list %s: %v", q.URL, err)
		failErr(w, err)
		return
	}
	l.Site, l.Headers = src.Name, src.Headers
	if l.Items == nil {
		l.Items = []Item{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(l)
}

func (s *server) media(w http.ResponseWriter, r *http.Request) {
	var q struct{ Site, URL, Page string }
	if !decode(w, r, &q) {
		return
	}
	src := sourceNamed(q.Site)
	if src == nil || (q.URL == "") == (q.Page == "") || q.Page != "" && src.Resolve == nil {
		fail(w, http.StatusBadRequest, "bad_request", 0)
		return
	}
	target := q.URL
	if q.Page != "" {
		var err error
		if target, err = src.Resolve(r.Context(), s.c, q.Page); err != nil {
			failErr(w, err)
			return
		}
	}
	res, err := s.c.Fetch(r.Context(), Req{URL: target, Headers: src.Headers})
	if err != nil {
		failErr(w, err)
		return
	}
	pass(w, res)
}

func (s *server) fetch(w http.ResponseWriter, r *http.Request) {
	var q Req
	if !decode(w, r, &q) {
		return
	}
	res, err := s.c.Fetch(r.Context(), q)
	if err != nil {
		failErr(w, err)
		return
	}
	pass(w, res)
}
