package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func call(s *server, path, key, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	if key != "" {
		req.Header.Set("Authorization", "Api-Key "+key)
	}
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	return rec
}

func errorOf(t *testing.T, rec *httptest.ResponseRecorder) (string, int) {
	var e struct {
		Error struct {
			Code   string
			Status int
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatal(rec.Body.String())
	}
	return e.Error.Code, e.Error.Status
}

func TestAPI(t *testing.T) {
	c, calls := site(map[string]any{
		"https://nhentai.net/api/v2/galleries/1":   J(`{"id":1,"title":{"pretty":"T"},"pages":[{"path":"galleries/9/1.jpg"}]}`),
		"https://i1.nhentai.net/galleries/9/1.jpg": &Resp{Status: 200, Type: "image/jpeg", Body: []byte("JPEG")},
		"https://e-hentai.org/s/a/1-1":             `<img id="img" src="https://h.test/1.webp">`,
		"https://h.test/1.webp":                    &Resp{Status: 200, Type: "image/webp", Body: []byte("WEBP")},
		"https://e621.net/favorites.json":          &Resp{Status: 401, Type: "application/json", Body: []byte(`{"success":false}`)},
	})
	s := &server{c: c, keys: []string{"k1", "k2"}}

	rec := call(s, "/", "", `{"url":"https://nhentai.net/g/1/"}`)
	eq(t, rec.Code, http.StatusUnauthorized)
	rec = call(s, "/", "bad", `{"url":"https://nhentai.net/g/1/"}`)
	eq(t, rec.Code, http.StatusUnauthorized)

	rec = call(s, "/", "k2", `{"url":"https://nhentai.net/g/1/"}`)
	eq(t, rec.Code, 200)
	has(t, json.RawMessage(rec.Body.Bytes()), `{"site":"nhentai","source":"https://nhentai.net/g/1/","title":"T","items":[{"url":"https://i1.nhentai.net/galleries/9/1.jpg"}]}`)
	rec = call(s, "/", "k1", `{"url":"https://hitomi.la/galleries/1.html"}`)
	_ = rec

	rec = call(s, "/", "k1", `{"url":"https://example.com/"}`)
	eq(t, rec.Code, 400)
	code, _ := errorOf(t, rec)
	eq(t, code, "unsupported")

	rec = call(s, "/", "k1", `{"url":"https://nhentai.net/g/2/"}`)
	eq(t, rec.Code, 502)
	code, status := errorOf(t, rec)
	eq(t, [2]any{code, status}, [2]any{"upstream", 404})

	rec = call(s, "/media", "k1", `{"site":"nhentai","url":"https://i1.nhentai.net/galleries/9/1.jpg"}`)
	eq(t, [3]any{rec.Code, rec.Header().Get("Content-Type"), rec.Body.String()}, [3]any{200, "image/jpeg", "JPEG"})

	rec = call(s, "/media", "k1", `{"site":"e-hentai","page":"https://e-hentai.org/s/a/1-1"}`)
	eq(t, rec.Body.String(), "WEBP")
	eq(t, (*calls)[len(*calls)-2].Headers["Cookie"], "nw=1")

	rec = call(s, "/media", "k1", `{"site":"nhentai","page":"https://x/"}`) // no resolver
	eq(t, rec.Code, 400)

	rec = call(s, "/fetch", "k1", `{"url":"https://e621.net/favorites.json","headers":{"Authorization":"Basic x"}}`)
	eq(t, [2]any{rec.Code, rec.Body.String()}, [2]any{401, `{"success":false}`})
	eq(t, (*calls)[len(*calls)-1].Headers["Authorization"], "Basic x")
}
