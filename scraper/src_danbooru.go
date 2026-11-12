package main

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Danbooru posts (one meme) and pools (a comic in pool order). API: https://danbooru.donmai.us/wiki_pages/help:api

const danbooruPage = 200 // posts per list page (API maximum)

var (
	danbooruHost = regexp.MustCompile(`(^|\.)donmai\.us$`) // danbooru, safebooru, …
	danbooruPath = regexp.MustCompile(`^/(posts|pools)/(\d+)`)
)

type danbooruPost struct {
	ID       int    `json:"id"`
	Rating   string `json:"rating"`
	Ext      string `json:"file_ext"`
	Size     int64  `json:"file_size"`
	FileURL  string `json:"file_url"`       // empty: hidden from guests
	LargeURL string `json:"large_file_url"` // the sample, or the file itself
	Media    struct {
		Variants []struct {
			URL string `json:"url"`
			Ext string `json:"file_ext"`
		}
	} `json:"media_asset"`
	Artist    string `json:"tag_string_artist"`
	Copyright string `json:"tag_string_copyright"`
	Character string `json:"tag_string_character"`
	General   string `json:"tag_string_general"`
	Meta      string `json:"tag_string_meta"`
	raw       json.RawMessage
}

func (p *danbooruPost) UnmarshalJSON(b []byte) error {
	type plain danbooruPost
	if err := json.Unmarshal(b, (*plain)(p)); err != nil {
		return err
	}
	p.raw = append(json.RawMessage(nil), b...)
	return nil
}

// danbooruMedia is the file to save: the original, a smaller one only when the original is over the Bot API limit
// (a photo: the sample; a webm: the mp4 variant when there is one); "": not importable.
func danbooruMedia(p *danbooruPost, lim Limits) string {
	var limit int64
	switch p.Ext {
	case "jpg", "jpeg", "png", "webp":
		limit = lim.Photo
	case "gif":
		limit = lim.Animation
	case "webm", "mp4": // Telegram does not play webm
		limit = lim.Video
		for _, v := range p.Media.Variants {
			if p.Ext == "webm" && v.Ext == "mp4" {
				return v.URL
			}
		}
	default: // zip (ugoira), swf, …
		return ""
	}
	switch {
	case p.FileURL == "":
		return ""
	case p.Size <= limit:
		return p.FileURL
	case slices.Contains([]string{"jpg", "jpeg", "png", "webp"}, p.Ext) && p.LargeURL != p.FileURL:
		return p.LargeURL
	}
	return ""
}

// danbooruItem has the full post as data and every tag group as tags; ratings e and q are porn.
func danbooruItem(p *danbooruPost, media string, data map[string]any) Item {
	tags := strings.Fields(strings.Join([]string{p.Artist, p.Copyright, p.Character, p.General, p.Meta}, " "))
	return Item{URL: media, Tags: tags, Data: data, Porn: p.Rating == "e" || p.Rating == "q"}
}

var danbooru = &Source{
	Name:    "danbooru",
	Headers: map[string]string{"User-Agent": "memesave/1.0 (danbooru importer)"}, // the CDN blocks a browser UA
	Match: func(u *url.URL) bool {
		return danbooruHost.MatchString(u.Hostname()) && danbooruPath.MatchString(u.Path)
	},
	Fetch: func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error) {
		m := danbooruPath.FindStringSubmatch(u.Path)
		kind, id := m[1], m[2]
		base := "https://" + strings.TrimPrefix(u.Hostname(), "www.")
		if kind == "posts" {
			var p danbooruPost
			if _, err := c.JSON(ctx, base+"/posts/"+id+".json", nil, &p); err != nil {
				return nil, err
			}
			l := &Listing{Source: base + "/posts/" + id}
			if media := danbooruMedia(&p, q.Limits); media != "" {
				l.Items = []Item{danbooruItem(&p, media, toMap([]byte(p.raw)))}
			}
			return l, nil
		}
		var pool struct {
			Name    string `json:"name"`
			PostIDs []int  `json:"post_ids"`
		}
		raw, err := c.JSON(ctx, base+"/pools/"+id+".json", nil, &pool)
		if err != nil {
			return nil, err
		}
		var posts []danbooruPost
		for page, got := 1, danbooruPage; got == danbooruPage; page++ {
			var list []danbooruPost
			v := url.Values{"tags": {"pool:" + id}, "limit": {strconv.Itoa(danbooruPage)}, "page": {strconv.Itoa(page)}}
			if _, err := c.JSON(ctx, base+"/posts.json?"+v.Encode(), nil, &list); err != nil {
				return nil, err
			}
			posts = append(posts, list...)
			got = len(list)
		}
		// The search order is not the pool order. The pool itself goes into every page's data (its post list is cut).
		order := map[int]int{}
		for i, p := range pool.PostIDs {
			order[p] = i
		}
		slices.SortStableFunc(posts, func(a, b danbooruPost) int { return order[a.ID] - order[b.ID] })
		info := toMap([]byte(raw))
		delete(info, "post_ids")
		l := &Listing{Source: base + "/pools/" + id, Title: str(strings.ReplaceAll(pool.Name, "_", " ")), Data: info}
		for i := range posts {
			if media := danbooruMedia(&posts[i], q.Limits); media != "" {
				data := toMap([]byte(posts[i].raw))
				data["pool"] = info
				l.Items = append(l.Items, danbooruItem(&posts[i], media, data))
			}
		}
		return l, nil
	},
}
