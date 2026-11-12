package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxFetch = 50 << 20

// fetchReq is the body of POST /fetch: a request to make through the proxy (http, https or socks5 URL).
type fetchReq struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Proxy   string            `json:"proxy"`
}

// fetch makes the request through the proxy and answers the upstream status, Content-Type and body.
func fetch(w http.ResponseWriter, r *http.Request) {
	var q fetchReq
	err := json.NewDecoder(r.Body).Decode(&q)
	var proxy *url.URL
	if err == nil {
		proxy, err = url.Parse(q.Proxy)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if q.Method == "" {
		q.Method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(r.Context(), q.Method, q.URL, strings.NewReader(q.Body))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	for k, v := range q.Headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(proxy)}}
	res, err := client.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxFetch+1))
	if err == nil && len(body) > maxFetch {
		err = fmt.Errorf("body over %d bytes", maxFetch)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if ct := res.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(res.StatusCode)
	_, _ = w.Write(body)
}
