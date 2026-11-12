// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: ImhentaiContent.kt, ImhentaiParser.kt.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var (
	imhPath     = regexp.MustCompile(`^/gallery/\d+`)
	formatsJSON = regexp.MustCompile(`(?s)'(\{"1":.*?\})'`) // the page list has only the first thumbnails, the reader has the format map
	bracketed   = regexp.MustCompile(`\[[^\]]*\]`)
	lastPart    = regexp.MustCompile(`[^/]*$`)
)

// formats is the format map of a reader page.
func formats(reader string) map[string]string {
	m := formatsJSON.FindStringSubmatch(reader)
	if m == nil {
		return nil
	}
	f := map[string]string{}
	if json.Unmarshal([]byte(m[1]), &f) != nil {
		return nil
	}
	return f
}

var imhentai = &Source{
	Name:    "imhentai",
	Headers: map[string]string{"Referer": "https://imhentai.xxx/"},
	Match:   func(u *url.URL) bool { return u.Hostname() == "imhentai.xxx" && imhPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		const site = "https://imhentai.xxx"
		id := strings.Split(u.Path, "/")[2]
		page, err := c.Text(ctx, site+"/gallery/"+id+"/", nil)
		if err != nil {
			return nil, err
		}
		reader, err := c.Text(ctx, site+"/view/"+id+"/1/", nil)
		if err != nil {
			return nil, err
		}
		hits := scrape(page, "div.right_details h1", "div.right_details .subtitle", "ul.galleries_info a", "li.pages")
		g := linkTags(only(hits, "ul.galleries_info a"))
		f := formats(reader)
		img := scrape(reader, "#gimg, .gthumb img") // the page image, or the first thumbnail: both in the image dir
		if f == nil || len(img) == 0 {
			return nil, errors.New("imhentai: no pages")
		}
		title := first(hits, "div.right_details h1")
		short := strings.TrimSpace(spaces.ReplaceAllString(bracketed.ReplaceAllString(title, ""), " ")) // Hentoid drops the [textual tags]
		if short == "" {
			short = title
		}
		var items []Item
		for _, u := range numbered(lastPart.ReplaceAllString(imgSrc(img[0].Attrs, site), ""), f) {
			items = append(items, Item{URL: u})
		}
		return &Listing{
			Source: site + "/gallery/" + id + "/",
			Title:  str(short),
			Tags:   g.flat(),
			Data:   g.into(map[string]any{"id": id, "title": title, "subtitle": first(hits, "div.right_details .subtitle"), "pages": num(first(hits, "li.pages"))}),
			Items:  items,
		}, nil
	},
}
