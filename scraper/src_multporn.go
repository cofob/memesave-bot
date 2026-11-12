// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: MultpornContent.kt, MultpornParser.kt.
package main

import (
	"context"
	"errors"
	"html"
	"net/url"
	"regexp"
	"strings"
)

const multpornSite = "https://multporn.net"

var (
	multpornPath = regexp.MustCompile(`^/(comics|hentai_manga)/[^/]+/?$`)
	juicebox     = regexp.MustCompile(`\\?/juicebox\\?/xml\\?/[^"]+`)
	linkURL      = regexp.MustCompile(`linkURL="([^"]*)"`)
	// Term links of the node by their path prefix: the group in data
	multpornGroups = [][2]string{{"/characters", "characters"}, {"/hentai", "series"}, {"/comics", "series"}, {"/authors", "artists"}, {"/category", "tags"}, {"/user_tags", "tags"}}
)

// term is the name of a term from its link: the last path segment (finn_the_human), without the _tag suffix of user tags.
func term(path string) string {
	s := path[strings.LastIndex(path, "/")+1:]
	if d, err := url.PathUnescape(s); err == nil {
		s = d
	}
	return strings.TrimSuffix(strings.ToLower(s), "_tag")
}

var multporn = &Source{
	Name:  "multporn",
	Match: func(u *url.URL) bool { return u.Hostname() == "multporn.net" && multpornPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		path := strings.TrimSuffix(u.Path, "/")
		page, err := c.Text(ctx, multpornSite+path, nil)
		if err != nil {
			return nil, err
		}
		hits := scrape(page, "#page-title", "head meta[name='dcterms.date']", ".node .links a")
		// The image list is a Juicebox XML, its URL is in the settings script
		xml := strings.ReplaceAll(juicebox.FindString(page), `\`, "")
		if xml == "" {
			return nil, errors.New("multporn: no images")
		}
		gx, err := c.Text(ctx, abs(xml, multpornSite), map[string]string{"Referer": multpornSite + path})
		if err != nil {
			return nil, err
		}
		var images []string
		for _, m := range linkURL.FindAllStringSubmatch(gx, -1) {
			images = append(images, html.UnescapeString(m[1]))
		}
		images = uniq(images)
		g := &groups{}
		for _, a := range only(hits, ".node .links a") {
			href, err := url.Parse(abs(a.Attrs["href"], multpornSite))
			if err != nil {
				continue
			}
			for _, pg := range multpornGroups {
				if strings.HasPrefix(href.Path, pg[0]) {
					name, group := term(href.Path), pg[1]
					if name == "ongoings" { // the "ongoings" section is a status
						name, group = "ongoing", "tags"
					}
					g.add(group, name)
					break
				}
			}
		}
		for k, v := range g.m {
			g.m[k] = uniq(v)
		}
		title := first(hits, "#page-title")
		var date any
		if m := only(hits, "head meta[name='dcterms.date']"); len(m) > 0 {
			date = m[0].Attrs["content"]
		}
		items := make([]Item, len(images))
		for i, s := range images {
			items[i] = Item{URL: s}
		}
		return &Listing{
			Source: multpornSite + path,
			Title:  str(title),
			Tags:   g.flat(),
			Data:   g.into(map[string]any{"title": title, "pages": len(images), "date": date}),
			Items:  items,
		}, nil
	},
}
