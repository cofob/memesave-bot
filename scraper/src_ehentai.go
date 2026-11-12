// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: EhentaiContent.kt, EHentaiParser.kt. No ExHentai (needs a login).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const ehPagesPerStep = 19 // listing pages per step (+1 request of the metadata)

var (
	ehHeaders = map[string]string{"Cookie": "nw=1"} // skips the content warning page
	ehPath    = regexp.MustCompile(`^/g/\d+/[0-9a-f]+`)
)

type ehMeta struct {
	Gid       int      `json:"gid"`
	Token     string   `json:"token"`
	Title     string   `json:"title"`
	TitleJpn  string   `json:"title_jpn"`
	Category  string   `json:"category"`
	Uploader  string   `json:"uploader"`
	Posted    string   `json:"posted"`
	Filecount string   `json:"filecount"`
	Filesize  int64    `json:"filesize"`
	Rating    string   `json:"rating"`
	Tags      []string `json:"tags"` // "namespace:tag"
}

// ehListing returns the image pages of one listing page ?p=N and the number of the listing pages.
func ehListing(ctx context.Context, c *Client, base string, p int) (int, []string, error) {
	html, err := c.Text(ctx, fmt.Sprintf("%s?p=%d", base, p), ehHeaders)
	if err != nil {
		return 0, nil, err
	}
	hits := scrape(html, "#gdt a", "table.ptt a")
	pages := 1
	for _, h := range only(hits, "table.ptt a") {
		if n, _ := strconv.Atoi(h.Text); n > pages {
			pages = n
		}
	}
	var links []string
	for _, h := range only(hits, "#gdt a") {
		if h.Attrs["href"] != "" {
			links = append(links, h.Attrs["href"])
		}
	}
	return pages, links, nil
}

var ehentai = &Source{
	Name:  "e-hentai",
	Match: func(u *url.URL) bool { return u.Hostname() == "e-hentai.org" && ehPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error) {
		parts := strings.Split(u.Path, "/") // ["", "g", gid, token, …]
		gid, token := parts[2], parts[3]
		base := fmt.Sprintf("https://e-hentai.org/g/%s/%s/", gid, token)
		l := &Listing{Source: base}
		if q.Cursor == "" {
			id, _ := strconv.Atoi(gid)
			body, _ := json.Marshal(map[string]any{"method": "gdata", "gidlist": [][]any{{id, token}}, "namespace": 1})
			res, err := c.must(c.Fetch(ctx, Req{URL: "https://api.e-hentai.org/api.php", Method: "POST", Headers: map[string]string{"Content-Type": "application/json"}, Body: string(body)}))
			if err != nil {
				return nil, err
			}
			var r struct{ Gmetadata []ehMeta }
			if json.Unmarshal(res.Body, &r) != nil || len(r.Gmetadata) == 0 || r.Gmetadata[0].Title == "" {
				return nil, errors.New("e-hentai: no metadata")
			}
			m := r.Gmetadata[0]
			var tags []string
			for _, t := range m.Tags {
				_, name, _ := strings.Cut(t, ":")
				tags = append(tags, tagName(name))
			}
			pages, _ := strconv.Atoi(m.Filecount)
			l.Title, l.Tags, l.Data = &m.Title, uniq(append(tags, tagName(m.Category))), toMap(m)
			l.Data.(map[string]any)["pages"] = pages
		}
		p, _ := strconv.Atoi(q.Cursor)
		last := p + 1 // the number of listing pages is known after the first one
		for n := 0; n < ehPagesPerStep && p < last; n, p = n+1, p+1 {
			pages, links, err := ehListing(ctx, c, base, p)
			if err != nil {
				return nil, err
			}
			last = pages
			for _, page := range links {
				l.Items = append(l.Items, Item{Page: page})
			}
		}
		if p < last {
			l.Next = strconv.Itoa(p)
		}
		return l, nil
	},
	Resolve: func(ctx context.Context, c *Client, page string) (string, error) {
		html, err := c.Text(ctx, page, ehHeaders)
		if err != nil {
			return "", err
		}
		for _, h := range scrape(html, "img#img", "#i3 img") {
			if src := h.Attrs["src"]; src != "" {
				if strings.Contains(src, "/509.gif") { // the quota is spent
					break
				}
				return src, nil
			}
		}
		return "", fmt.Errorf("e-hentai: no image (bandwidth limit?) %s", page)
	},
}
