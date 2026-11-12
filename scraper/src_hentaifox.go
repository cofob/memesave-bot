// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: HentaifoxContent.kt, HentaifoxParser.kt.
package main

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var hfPath = regexp.MustCompile(`^/(gallery|g)/\d+`)

var hentaifox = &Source{
	Name:    "hentaifox",
	Headers: map[string]string{"Referer": "https://hentaifox.com/"},
	Match:   func(u *url.URL) bool { return u.Hostname() == "hentaifox.com" && hfPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		const site = "https://hentaifox.com"
		id := strings.Split(u.Path, "/")[2]
		page, err := c.Text(ctx, site+"/gallery/"+id+"/", nil)
		if err != nil {
			return nil, err
		}
		reader, err := c.Text(ctx, site+"/g/"+id+"/1/", nil)
		if err != nil {
			return nil, err
		}
		hits := scrape(page, ".info h1", ".info a.tag_btn", ".info .pages")
		g := linkTags(only(hits, ".info a.tag_btn"))
		f := formats(reader)
		img := scrape(reader, "#gimg")
		if f == nil || len(img) == 0 {
			return nil, errors.New("hentaifox: no pages")
		}
		title := first(hits, ".info h1")
		var items []Item
		for _, u := range numbered(lastPart.ReplaceAllString(imgSrc(img[0].Attrs, site), ""), f) {
			items = append(items, Item{URL: u})
		}
		return &Listing{
			Source: site + "/gallery/" + id + "/",
			Title:  str(title),
			Tags:   g.flat(),
			Data:   g.into(map[string]any{"id": id, "title": title, "pages": num(first(hits, ".info .pages"))}),
			Items:  items,
		}, nil
	},
}
