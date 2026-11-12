// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: ASMHentaiContent.kt, ASMHentaiParser.kt.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var (
	asmPath = regexp.MustCompile(`^/(g|gallery)/\d+`)
	ext     = regexp.MustCompile(`\.\w+$`)
)

var asmhentai = &Source{
	Name:    "asmhentai",
	Headers: map[string]string{"Referer": "https://asmhentai.com/"},
	Match:   func(u *url.URL) bool { return u.Hostname() == "asmhentai.com" && asmPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		const site = "https://asmhentai.com"
		id := strings.Split(u.Path, "/")[2]
		page, err := c.Text(ctx, site+"/g/"+id+"/", nil)
		if err != nil {
			return nil, err
		}
		reader, err := c.Text(ctx, site+"/gallery/"+id+"/1/", nil)
		if err != nil {
			return nil, err
		}
		hits := scrape(page, "div.info h1", "div.info h2", "div.info div.tags a", "div.pages h3")
		g := linkTags(only(hits, "div.info div.tags a"))
		rd := scrape(reader, ".reader_overlay a img, .full_image a img, .full_gallery a img", ".pages_btn")
		var img *Hit
		for i := range rd {
			if rd[i].Sel != ".pages_btn" {
				img = &rd[i]
				break
			}
		}
		count := 0
		if n := digits.FindAllString(first(rd, ".pages_btn"), -1); len(n) > 0 { // "1 of 18"
			count, _ = strconv.Atoi(n[len(n)-1])
		}
		if img == nil || count == 0 {
			return nil, errors.New("asmhentai: no pages")
		}
		src := imgSrc(img.Attrs, site)
		e := ext.FindString(src) // the extension of the first page is taken for all, as Hentoid does
		dir := lastPart.ReplaceAllString(src, "")
		items := make([]Item, count)
		for i := range items {
			items[i] = Item{URL: fmt.Sprintf("%s%d%s", dir, i+1, e)}
		}
		title := first(hits, "div.info h1")
		return &Listing{
			Source: site + "/g/" + id + "/",
			Title:  str(title),
			Tags:   g.flat(),
			Data:   g.into(map[string]any{"id": id, "title": title, "subtitle": first(hits, "div.info h2"), "pages": count}),
			Items:  items,
		}, nil
	},
}
