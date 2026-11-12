package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// Tailspace (tailspace.com, formerly yiffer.xyz): the comic of the page loader data. The page is a React Router app:
// the data is a turbo-stream (a flat JSON array, an object is {"_<key index>": <value index>}) in streamController.enqueue.

var (
	tailspaceDomain = regexp.MustCompile(`(^|\.)(tailspace\.com|yiffer\.xyz)$`)
	tsPath          = regexp.MustCompile(`^/c/[^/]+/?$`)
	tsOldPath       = regexp.MustCompile(`^/[^/]+/?$`) // yiffer.xyz/<name>
	enqueue         = regexp.MustCompile(`streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)`)
)

// turbo decodes the value at index i of a turbo-stream array; specials (negative indexes) and typed values are nil.
func turbo(arr []json.RawMessage, i int, depth int) any {
	if i < 0 || i >= len(arr) || depth > 20 {
		return nil
	}
	var obj map[string]int
	if json.Unmarshal(arr[i], &obj) == nil {
		out := map[string]any{}
		for k, v := range obj {
			var ki int
			if _, err := fmt.Sscanf(k, "_%d", &ki); err != nil || ki >= len(arr) {
				continue
			}
			var key string
			if json.Unmarshal(arr[ki], &key) == nil {
				out[key] = turbo(arr, v, depth+1)
			}
		}
		return out
	}
	var list []json.RawMessage
	if json.Unmarshal(arr[i], &list) == nil {
		var typ string
		if len(list) > 0 && json.Unmarshal(list[0], &typ) == nil && len(typ) == 1 {
			return nil // a typed value (date, promise, …)
		}
		out := make([]any, len(list))
		for j, raw := range list {
			var idx int
			if json.Unmarshal(raw, &idx) == nil {
				out[j] = turbo(arr, idx, depth+1)
			}
		}
		return out
	}
	var v any
	_ = json.Unmarshal(arr[i], &v)
	return v
}

type tsComic struct {
	ID            int    `json:"id"`
	Name          string `json:"name"`
	Slug          string `json:"slug"`
	State         string `json:"state"`
	Category      string `json:"category"`
	NumberOfPages int    `json:"numberOfPages"`
	E621PoolID    *int   `json:"e621PoolId"`
	Artist        struct {
		Name string `json:"name"`
	} `json:"artist"`
	AdditionalArtists []struct {
		Name string `json:"name"`
	} `json:"additionalArtists"`
	Tags []struct {
		Name     string  `json:"name"`
		Category *string `json:"category"`
	} `json:"tags"`
	Pages []struct {
		Token      string  `json:"token"`
		PageNumber float64 `json:"pageNumber"`
		FileType   string  `json:"fileType"`
	} `json:"pages"`
}

// tsComicOf finds the comic in the loader data of the page.
func tsComicOf(page string) (*tsComic, error) {
	m := enqueue.FindStringSubmatch(page)
	if m == nil {
		return nil, errors.New("tailspace: no page data")
	}
	var payload string
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(m[1]), &payload); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(payload), &arr); err != nil {
		return nil, err
	}
	root, _ := turbo(arr, 0, 0).(map[string]any)
	loaders, _ := root["loaderData"].(map[string]any)
	for _, l := range loaders {
		if d, ok := l.(map[string]any); ok && d["comic"] != nil {
			c := &tsComic{}
			b, _ := json.Marshal(d["comic"])
			return c, json.Unmarshal(b, c)
		}
	}
	return nil, errors.New("tailspace: not a comic page")
}

var tailspace = &Source{
	Name:    "tailspace",
	Headers: map[string]string{"Referer": "https://tailspace.com/"},
	Match: func(u *url.URL) bool {
		return tailspaceDomain.MatchString(u.Hostname()) && (tsPath.MatchString(u.Path) || strings.HasSuffix(u.Hostname(), "yiffer.xyz") && tsOldPath.MatchString(u.Path))
	},
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		name := strings.TrimPrefix(strings.Trim(u.Path, "/"), "c/") // yiffer.xyz/<name> and tailspace.com/c/<name>
		page, err := c.Text(ctx, "https://tailspace.com/c/"+url.PathEscape(name), nil)
		if err != nil {
			return nil, err
		}
		comic, err := tsComicOf(page)
		if err != nil {
			return nil, err
		}
		pages := comic.Pages
		sort.SliceStable(pages, func(i, j int) bool { return pages[i].PageNumber < pages[j].PageNumber })
		var items []Item
		for _, p := range pages {
			ext := p.FileType
			if ext == "" {
				ext = "jpg" // old (yiffer) comics have no file type: their pages are jpg
			}
			items = append(items, Item{URL: fmt.Sprintf("https://pics.tailspace.com/comics/%d/%s.%s", comic.ID, p.Token, ext)})
		}
		if len(items) == 0 {
			return nil, errors.New("tailspace: no pages")
		}
		g := &groups{}
		g.add("artists", tagName(comic.Artist.Name))
		for _, a := range comic.AdditionalArtists {
			g.add("artists", tagName(a.Name))
		}
		for _, t := range comic.Tags {
			g.add("tags", tagName(t.Name))
		}
		if comic.Category != "" {
			g.add("categories", tagName(comic.Category))
		}
		slug := comic.Slug
		if slug == "" {
			slug = name
		}
		return &Listing{
			Source: "https://tailspace.com/c/" + url.PathEscape(slug),
			Title:  str(comic.Name),
			Tags:   g.flat(),
			Data:   g.into(map[string]any{"id": comic.ID, "title": comic.Name, "slug": slug, "state": comic.State, "pages": len(items), "e621_pool": comic.E621PoolID}),
			Items:  items,
		}, nil
	},
}
