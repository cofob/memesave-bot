package main

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// xlecx (DataLife Engine comic pages): the full images of the gallery, the info fields (artist, …) and the tags.

var (
	xlecxDomain = regexp.MustCompile(`(^|\.)xlecx\.[a-z]+$`)
	xlecxPath   = regexp.MustCompile(`^/\d+-[^/]+\.html$`)
	xlecxField  = regexp.MustCompile(`/xfsearch/([^/]+)/`)
)

var xlecx = &Source{
	Name:    "xlecx",
	Headers: map[string]string{"Referer": "https://xlecx.one/"},
	Match:   func(u *url.URL) bool { return xlecxDomain.MatchString(u.Hostname()) && xlecxPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		source := "https://" + u.Hostname() + u.Path
		page, err := c.Text(ctx, source, nil)
		if err != nil {
			return nil, err
		}
		hits := scrape(page, "article h1", "article a[href*='/xfsearch/']", ".tags-list a", "ul.xfieldimagegallery a")
		g := &groups{}
		for _, a := range only(hits, "article a[href*='/xfsearch/']") {
			if m := xlecxField.FindStringSubmatch(a.Attrs["href"]); m != nil && a.Text != "" {
				g.add(strings.TrimSuffix(m[1], "s")+"s", tagName(a.Text)) // artist → artists
			}
		}
		for _, a := range only(hits, ".tags-list a") {
			g.add("tags", tagName(a.Text))
		}
		var items []Item
		for _, a := range only(hits, "ul.xfieldimagegallery a") {
			items = append(items, Item{URL: abs(a.Attrs["href"], source)})
		}
		if len(items) == 0 {
			return nil, errors.New("xlecx: no images")
		}
		title := first(hits, "article h1")
		return &Listing{Source: source, Title: str(title), Tags: g.flat(), Data: g.into(map[string]any{"title": title, "pages": len(items)}), Items: items}, nil
	},
}
