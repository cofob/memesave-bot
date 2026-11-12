// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: MusesContent.kt, MusesParser.kt.
package main

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

const musesHost = "https://comics.8muses.com"

var (
	musesDomain = regexp.MustCompile(`(^|\.)8muses\.com$`)
	number      = regexp.MustCompile(`^\d+$`)
	// Publishers whose second breadcrumb is an author, not a series (MusesContent.kt)
	withAuthors   = []string{"various authors", "fakku comics", "hentai and manga english", "renderotica comics", "tg comics", "affect3d comics", "johnpersons.com comics"}
	notPublishers = []string{"various authors", "hentai and manga english"}
)

var muses = &Source{
	Name: "8muses",
	Match: func(u *url.URL) bool {
		return musesDomain.MatchString(u.Hostname()) && strings.Contains(u.Path, "/album/")
	},
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		res, err := c.Get(ctx, musesHost+u.Path, nil) // www.8muses.com/comics/album/… redirects here
		if err != nil {
			return nil, err
		}
		hits := scrape(string(res.Body), ".top-menu-breadcrumb a", ".gallery a", ".gallery img")
		// Only a leaf album has links to pictures (they end with a number); the others are lists of albums
		var pics []string
		for _, a := range only(hits, ".gallery a") {
			if h := a.Attrs["href"]; number.MatchString(h[strings.LastIndex(h, "/")+1:]) {
				pics = append(pics, h)
			}
		}
		var thumbs []string
		for _, i := range only(hits, ".gallery img") {
			thumbs = append(thumbs, imgSrc(i.Attrs, musesHost))
		}
		thumbs = slices.DeleteFunc(uniq(thumbs), func(s string) bool { return !strings.Contains(s, "/image/th/") })
		if len(pics) == 0 || len(thumbs) == 0 {
			return nil, errors.New("8muses: not an album of pictures")
		}

		var crumbs []string // [home icon, publisher, author or series, …, title]
		for _, a := range only(hits, ".top-menu-breadcrumb a") {
			crumbs = append(crumbs, a.Text)
		}
		crumbs = append(crumbs, "", "", "")[:max(len(crumbs), 3)]
		publisher, second, rest := crumbs[1], crumbs[2], crumbs[3:]
		key := strings.ToLower(publisher)
		isAuthor := slices.Contains(withAuthors, key)
		title := crumbs[len(crumbs)-1]
		if len(rest) > 1 {
			title = strings.Join(rest, " - ")
		} else if second != "" && !isAuthor && title != "" && !strings.HasPrefix(strings.ToLower(title), strings.ToLower(second)) {
			title = second + " - " + title
		}
		// Tags are not on the album page but on its first picture page; the site may not show them
		siteTags := []string{}
		if picture, err := c.Text(ctx, abs(pics[0], musesHost), nil); err == nil {
			for _, a := range scrape(picture, ".album-tags a[href*='/search/tag']") {
				siteTags = append(siteTags, a.Text)
			}
		}
		circles, artists, series := []string{}, []string{}, []string{}
		if publisher != "" && !slices.Contains(notPublishers, key) {
			circles = append(circles, publisher)
		}
		if second != "" && len(rest) > 0 {
			if isAuthor {
				artists = append(artists, second)
			} else {
				series = append(series, second)
			}
		}
		items := make([]Item, len(thumbs))
		for i, t := range thumbs {
			items[i] = Item{URL: abs(strings.Replace(t, "/image/th/", "/image/fl/", 1), musesHost)} // the large image has the same name as the thumbnail
		}
		path := u.Path
		if f, err := url.Parse(res.URL); err == nil && res.URL != "" {
			path = f.Path
		}
		return &Listing{
			Source: musesHost + path,
			Title:  str(title),
			Tags:   uniq(tagNames(slices.Concat(circles, artists, series, siteTags))),
			Data:   map[string]any{"title": title, "publisher": publisher, "circles": circles, "artists": artists, "series": series, "tags": siteTags, "pages": len(thumbs)},
			Items:  items,
		}, nil
	},
}
