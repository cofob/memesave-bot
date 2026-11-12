// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: NhentaiContent.kt, NhentaiParser.kt (the site API v2 instead of the HTML).
package main

import (
	"cmp"
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var nhPath = regexp.MustCompile(`^/g/\d+`)

var nhentai = &Source{
	Name:  "nhentai",
	Match: func(u *url.URL) bool { return u.Hostname() == "nhentai.net" && nhPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		id := strings.Split(u.Path, "/")[2]
		var g struct {
			ID      int    `json:"id"`
			MediaID string `json:"media_id"`
			Title   struct {
				English  string `json:"english,omitempty"`
				Japanese string `json:"japanese,omitempty"`
				Pretty   string `json:"pretty,omitempty"`
			} `json:"title"`
			Scanlator    string `json:"scanlator"`
			UploadDate   int64  `json:"upload_date"`
			NumPages     int    `json:"num_pages"`
			NumFavorites int    `json:"num_favorites"`
			Tags         []struct{ Type, Name string }
			Pages        []struct{ Path string }
		}
		if _, err := c.JSON(ctx, "https://nhentai.net/api/v2/galleries/"+id, nil, &g); err != nil {
			return nil, err
		}
		gr := &groups{}
		for _, t := range g.Tags {
			if types[t.Type] != "" {
				gr.add(types[t.Type], tagName(t.Name))
			}
		}
		items := make([]Item, len(g.Pages))
		for i, p := range g.Pages {
			items[i] = Item{URL: "https://i1.nhentai.net/" + p.Path}
		}
		data := gr.into(map[string]any{"id": g.ID, "media_id": g.MediaID, "title": g.Title, "scanlator": g.Scanlator, "pages": g.NumPages, "favorites": g.NumFavorites,
			"uploaded": time.Unix(g.UploadDate, 0).UTC().Format("2006-01-02T15:04:05.000Z")})
		return &Listing{
			Source: fmt.Sprintf("https://nhentai.net/g/%d/", g.ID),
			Title:  str(cmp.Or(g.Title.Pretty, g.Title.English, g.Title.Japanese)),
			Tags:   gr.flat(),
			Data:   data,
			Items:  items,
		}, nil
	},
}
