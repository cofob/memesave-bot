package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// e621 posts (one meme) and pools (a comic in pool order). API: https://e621.net/wiki_pages/2425

const (
	e621API  = "https://e621.net"
	e621UA   = "memesave/1.0 (e621 importer)" // generic: never user data
	e621Page = 320                            // posts per list page (API maximum)
)

var (
	e621Host = regexp.MustCompile(`^(www\.)?e621\.net$`)
	e621Path = regexp.MustCompile(`^/(posts|pools)/(\d+)`)
)

type e621Variant struct {
	URL  *string `json:"url"`
	Size int64   `json:"size"`
}

// e621Tags are the tag groups in the order of the API.
type e621Tags []struct {
	Group string
	Tags  []string
}

func (t *e621Tags) UnmarshalJSON(b []byte) error {
	d := json.NewDecoder(bytes.NewReader(b))
	if _, err := d.Token(); err != nil { // {
		return err
	}
	for d.More() {
		k, err := d.Token()
		if err != nil {
			return err
		}
		var v []string
		if err := d.Decode(&v); err != nil {
			return err
		}
		*t = append(*t, struct {
			Group string
			Tags  []string
		}{k.(string), v})
	}
	return nil
}

type e621Post struct {
	ID     int    `json:"id"`
	Rating string `json:"rating"`
	File   struct {
		e621Variant
		Ext string `json:"ext"`
	} `json:"file"`
	Sample struct {
		URL        *string `json:"url"`
		Alternates struct {
			Samples  map[string]*e621Variant `json:"samples"`
			Variants struct {
				MP4 *e621Variant `json:"mp4"`
			} `json:"variants"`
		} `json:"alternates"`
	} `json:"sample"`
	Tags  e621Tags `json:"tags"`
	Pools []int    `json:"pools"`
	raw   json.RawMessage
}

func (p *e621Post) UnmarshalJSON(b []byte) error {
	type plain e621Post
	if err := json.Unmarshal(b, (*plain)(p)); err != nil {
		return err
	}
	p.raw = append(json.RawMessage(nil), b...)
	return nil
}

// mediaURL is the file to save: the original, or a smaller one only when the original is over the Bot API limit
// (a photo or GIF: the sample; a video: the mp4 in the original size, then 720p, 480p); "": not importable.
func mediaURL(p *e621Post, lim Limits) string {
	f := p.File
	if f.Ext == "webm" || f.Ext == "mp4" {
		s := p.Sample.Alternates
		var all []*e621Variant
		if f.Ext == "mp4" {
			all = append(all, &f.e621Variant)
		}
		all = append(all, s.Variants.MP4, s.Samples["720p"], s.Samples["480p"]) // a webm as an mp4: Telegram does not play webm
		for _, v := range all {
			if v != nil && v.URL != nil && *v.URL != "" && v.Size <= lim.Video {
				return *v.URL
			}
		}
		return ""
	}
	if !slices.Contains([]string{"jpg", "png", "gif", "webp"}, f.Ext) { // swf, …
		return ""
	}
	limit := lim.Photo
	if f.Ext == "gif" {
		limit = lim.Animation
	}
	if f.URL != nil && *f.URL != "" && f.Size <= limit {
		return *f.URL
	}
	if p.Sample.URL != nil {
		return *p.Sample.URL
	}
	return ""
}

// postItem has the full post as data and every tag group (except invalid) as tags; rating e is porn.
func postItem(p *e621Post, url string, data any) Item {
	var tags []string
	for _, g := range p.Tags {
		if g.Group != "invalid" {
			tags = append(tags, g.Tags...)
		}
	}
	return Item{URL: url, Tags: tags, Data: data, Porn: p.Rating == "e"}
}

var e621 = &Source{
	Name:    "e621",
	Headers: map[string]string{"User-Agent": e621UA},
	Match:   func(u *url.URL) bool { return e621Host.MatchString(u.Hostname()) && e621Path.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error) {
		m := e621Path.FindStringSubmatch(u.Path)
		kind, id := m[1], m[2]
		h := map[string]string{"User-Agent": e621UA}
		if q.Auth != "" {
			h["Authorization"] = q.Auth
		}
		if kind == "posts" {
			var r struct{ Post e621Post }
			if _, err := c.JSON(ctx, e621API+"/posts/"+id+".json", h, &r); err != nil {
				return nil, err
			}
			l := &Listing{Source: e621API + "/posts/" + id}
			if media := mediaURL(&r.Post, q.Limits); media != "" {
				l.Items = []Item{postItem(&r.Post, media, r.Post.raw)}
			}
			return l, nil
		}
		var pool struct {
			Name    string `json:"name"`
			PostIDs []int  `json:"post_ids"`
		}
		raw, err := c.JSON(ctx, e621API+"/pools/"+id+".json", h, &pool)
		if err != nil {
			return nil, err
		}
		var posts []e621Post
		for page, got := 1, e621Page; got == e621Page; page++ {
			var list struct{ Posts []e621Post }
			v := url.Values{"tags": {"pool:" + id}, "limit": {strconv.Itoa(e621Page)}, "page": {strconv.Itoa(page)}}
			if _, err := c.JSON(ctx, e621API+"/posts.json?"+v.Encode(), h, &list); err != nil {
				return nil, err
			}
			posts = append(posts, list.Posts...)
			got = len(list.Posts)
		}
		// The search order is not the pool order. The pool itself goes into every page's data (its post list is cut).
		order := map[int]int{}
		for i, p := range pool.PostIDs {
			order[p] = i
		}
		slices.SortStableFunc(posts, func(a, b e621Post) int { return order[a.ID] - order[b.ID] })
		info := toMap([]byte(raw))
		delete(info, "post_ids")
		l := &Listing{Source: e621API + "/pools/" + id, Title: str(strings.ReplaceAll(pool.Name, "_", " "))}
		for i := range posts {
			if media := mediaURL(&posts[i], q.Limits); media != "" {
				data := toMap([]byte(posts[i].raw))
				data["pool"] = info
				l.Items = append(l.Items, postItem(&posts[i], media, data))
			}
		}
		return l, nil
	},
}
