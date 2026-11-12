// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: KemonoContent.kt, KemonoParser.kt.
package main

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const (
	kemonoSite         = "https://kemono.cr"
	kemonoPage         = 50 // posts per API call
	kemonoCallsPerStep = 20
)

var (
	kemonoDomain = regexp.MustCompile(`(^|\.)kemono\.(cr|su|party)$`)
	kemonoPath   = regexp.MustCompile(`^/[^/]+/user/[^/]+(/post/[^/]+)?/?$`)
	kemonoImage  = regexp.MustCompile(`(?i)\.(jpe?g|png|webp|gif)$`)
)

type kemonoPost struct {
	ID          string                  `json:"id"`
	User        string                  `json:"user"`
	Service     string                  `json:"service"`
	Title       string                  `json:"title"`
	Content     string                  `json:"content"`
	Published   string                  `json:"published"`
	Edited      string                  `json:"edited"`
	File        struct{ Path string }   `json:"file"`
	Attachments []struct{ Path string } `json:"attachments"`
	Tags        []string                `json:"tags"`
}

type kemonoProfile struct {
	Name      string `json:"name"`
	Service   string `json:"service"`
	PostCount int    `json:"post_count"`
	raw       map[string]any
}

// kemonoAPI is an API call; DDoS-Guard lets Accept: text/css through.
func kemonoAPI(ctx context.Context, c *Client, path string, v any) ([]byte, error) {
	return c.JSON(ctx, kemonoSite+"/api/v1/"+path, map[string]string{"Accept": "text/css"}, v)
}

func kemonoProfileOf(ctx context.Context, c *Client, base string) (*kemonoProfile, error) {
	p := &kemonoProfile{}
	raw, err := kemonoAPI(ctx, c, base+"/profile", p)
	if err == nil {
		p.raw = toMap(raw)
	}
	return p, err
}

// images are the image URLs of a post: the main file and the attachments (the file is usually among them).
func (p *kemonoPost) images() []Item {
	paths := []string{p.File.Path}
	for _, a := range p.Attachments {
		paths = append(paths, a.Path)
	}
	var items []Item
	for _, s := range uniq(paths) {
		if kemonoImage.MatchString(s) {
			items = append(items, Item{URL: kemonoSite + "/data" + s})
		}
	}
	return items
}

func (p *kemonoPost) data() map[string]any {
	content := []rune(p.Content)
	return map[string]any{"id": p.ID, "title": p.Title, "published": p.Published, "edited": p.Edited, "tags": p.Tags, "content": string(content[:min(len(content), 2000)])}
}

var kemono = &Source{
	Name:    "kemono",
	Headers: map[string]string{"Referer": kemonoSite + "/"},
	Match:   func(u *url.URL) bool { return kemonoDomain.MatchString(u.Hostname()) && kemonoPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error) {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/") // [service, user, id, post?, postId?]
		base := parts[0] + "/user/" + parts[2]
		if len(parts) > 4 {
			return kemonoOne(ctx, c, base, parts[4])
		}
		return kemonoCreator(ctx, c, base, q.Cursor)
	},
}

// kemonoOne lists one post: one post is one gallery.
func kemonoOne(ctx context.Context, c *Client, base, id string) (*Listing, error) {
	var r struct{ Post kemonoPost }
	if _, err := kemonoAPI(ctx, c, base+"/post/"+id, &r); err != nil {
		return nil, err
	}
	profile, err := kemonoProfileOf(ctx, c, base)
	if err != nil {
		return nil, err
	}
	p := r.Post
	return &Listing{
		Source: kemonoSite + "/" + base + "/post/" + id,
		Title:  &p.Title,
		Tags:   uniq(tagNames(slices.Concat([]string{profile.Name, profile.Service}, p.Tags))),
		Data:   map[string]any{"creator": profile.raw, "post": p.data()},
		Items:  p.images(),
	}, nil
}

// kemonoCreator lists all posts of a creator as one comic, the oldest first: the offsets go from the last one to 0, the cursor is the next offset.
func kemonoCreator(ctx context.Context, c *Client, base, cursor string) (*Listing, error) {
	l := &Listing{Source: kemonoSite + "/" + base}
	offset, _ := strconv.Atoi(cursor)
	if cursor == "" {
		profile, err := kemonoProfileOf(ctx, c, base)
		if err != nil {
			return nil, err
		}
		offset = max(0, (profile.PostCount+kemonoPage-1)/kemonoPage-1) * kemonoPage
		l.Title, l.Tags, l.Data = &profile.Name, uniq(tagNames([]string{profile.Name, profile.Service})), map[string]any{"creator": profile.raw}
	}
	for n := 0; n < kemonoCallsPerStep && offset >= 0; n, offset = n+1, offset-kemonoPage {
		var posts []kemonoPost
		if _, err := kemonoAPI(ctx, c, fmt.Sprintf("%s/posts?o=%d", base, offset), &posts); err != nil {
			return nil, err
		}
		slices.Reverse(posts)
		for _, p := range posts {
			for _, it := range p.images() {
				it.Tags = tagNames(p.Tags)
				it.Data = map[string]any{"creator": map[string]any{"id": p.User, "service": p.Service}, "post": p.data()}
				l.Items = append(l.Items, it)
			}
		}
	}
	if offset >= 0 {
		l.Next = strconv.Itoa(offset)
	}
	return l, nil
}
