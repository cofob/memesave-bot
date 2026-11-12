// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: HitomiContent.kt, HitomiParser.kt (the page URLs come from gg.js, as in the site reader).
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

const hitomiCDN = "gold-usergeneratedcontent.net"

var (
	hitomiHeaders = map[string]string{"Referer": "https://hitomi.la/"}
	hitomiPath    = regexp.MustCompile(`(?:-|/(?:galleries|reader)/)\d+\.html$`)
	hitomiID      = regexp.MustCompile(`(\d+)\.html$`)
	ggCase        = regexp.MustCompile(`case (\d+):`)
	ggDefault     = regexp.MustCompile(`var o = (\d)`)
	ggHit         = regexp.MustCompile(`\bo = (\d);\s*break`)
	ggB           = regexp.MustCompile(`b: '([^']*)'`)
)

type named []map[string]any

func (a named) names(key string) []string {
	out := []string{}
	for _, x := range a {
		out = append(out, tagName(fmt.Sprint(x[key])))
	}
	return out
}

// parseGg reads gg.js: the build path b, and the subdomain number of a hash (m is a switch over the numbers that map to 0).
func parseGg(js string) (func(hash string, webp bool, ext string) string, error) {
	zero := map[int]bool{}
	for _, m := range ggCase.FindAllStringSubmatch(js, -1) {
		n, _ := strconv.Atoi(m[1])
		zero[n] = true
	}
	dflt, hit := 1, 0
	if m := ggDefault.FindStringSubmatch(js); m != nil {
		dflt, _ = strconv.Atoi(m[1])
	}
	if m := ggHit.FindStringSubmatch(js); m != nil {
		hit, _ = strconv.Atoi(m[1])
	}
	b := ggB.FindStringSubmatch(js)
	if b == nil {
		return nil, errors.New("hitomi: gg.js")
	}
	return func(hash string, webp bool, ext string) string {
		g64, _ := strconv.ParseInt(hash[len(hash)-1:]+hash[len(hash)-3:len(hash)-1], 16, 64)
		g := int(g64)
		sub := 1 + dflt
		if zero[g] {
			sub = 1 + hit
		}
		if webp {
			return fmt.Sprintf("https://w%d.%s/%s%d/%s.webp", sub, hitomiCDN, b[1], g, hash)
		}
		return fmt.Sprintf("https://%d.%s/images/%s%d/%s.%s", sub, hitomiCDN, b[1], g, hash, ext)
	}, nil
}

var hitomi = &Source{
	Name:    "hitomi",
	Headers: hitomiHeaders,
	Match:   func(u *url.URL) bool { return u.Hostname() == "hitomi.la" && hitomiPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		id := hitomiID.FindStringSubmatch(u.Path)[1]
		js, err := c.Text(ctx, fmt.Sprintf("https://ltn.%s/galleries/%s.js", hitomiCDN, id), hitomiHeaders)
		if err != nil {
			return nil, err
		}
		gg, err := c.Text(ctx, fmt.Sprintf("https://ltn.%s/gg.js", hitomiCDN), hitomiHeaders)
		if err != nil {
			return nil, err
		}
		var info struct {
			ID            any     `json:"id"`
			Title         string  `json:"title"`
			JapaneseTitle *string `json:"japanese_title"`
			Type          string  `json:"type"`
			Language      string  `json:"language"`
			Date          string  `json:"date"`
			Datepublished *string `json:"datepublished"`
			Artists       named   `json:"artists"`
			Groups        named   `json:"groups"`
			Parodys       named   `json:"parodys"`
			Characters    named   `json:"characters"`
			Tags          named   `json:"tags"`
			Files         []struct {
				Hash    string `json:"hash"`
				Name    string `json:"name"`
				Haswebp int    `json:"haswebp"`
				Hasavif int    `json:"hasavif"`
			} `json:"files"`
		}
		if i, j := strings.Index(js, "{"), strings.LastIndex(js, "}"); i < 0 || j < i || json.Unmarshal([]byte(js[i:j+1]), &info) != nil { // var galleryinfo = {…}
			return nil, errors.New("hitomi: gallery info")
		}
		urlOf, err := parseGg(gg)
		if err != nil {
			return nil, err
		}
		g := &groups{}
		g.add("artists", info.Artists.names("artist")...)
		g.add("groups", info.Groups.names("group")...)
		g.add("parodies", info.Parodys.names("parody")...)
		g.add("characters", info.Characters.names("character")...)
		g.add("tags", info.Tags.names("tag")...)
		g.add("languages")
		g.add("categories")
		if info.Language != "" {
			g.add("languages", tagName(info.Language))
		}
		if info.Type != "" {
			g.add("categories", tagName(info.Type))
		}
		items := make([]Item, len(info.Files))
		for i, f := range info.Files {
			items[i] = Item{URL: urlOf(f.Hash, f.Haswebp != 0 || f.Hasavif != 0, f.Name[strings.LastIndex(f.Name, ".")+1:])}
		}
		return &Listing{
			Source: fmt.Sprintf("https://hitomi.la/galleries/%v.html", info.ID),
			Title:  &info.Title,
			Tags:   g.flat(),
			Data:   g.into(map[string]any{"id": info.ID, "title": info.Title, "japanese_title": info.JapaneseTitle, "pages": len(info.Files), "date": info.Date, "published": info.Datepublished}),
			Items:  items,
		}, nil
	},
}
