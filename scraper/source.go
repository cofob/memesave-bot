package main

import (
	"context"
	"net/url"
)

// Item is an image: URL, or a Page that the source resolves to the image URL (E-Hentai). Tags and data are of this item only.
type Item struct {
	URL  string   `json:"url,omitempty"`
	Page string   `json:"page,omitempty"`
	Tags []string `json:"tags,omitempty"`
	Data any      `json:"data,omitempty"`
	Porn bool     `json:"porn,omitempty"`
}

// Listing is one listing step. Source is the canonical URL; title, tags and data matter in the first step.
type Listing struct {
	Site   string   `json:"site"`
	Source string   `json:"source"`
	Title  *string  `json:"title"`
	Tags   []string `json:"tags,omitempty"` // of the whole gallery
	Data   any      `json:"data,omitempty"` // full source object (source_meta)
	Items  []Item   `json:"items"`
	Next   string   `json:"next,omitempty"` // cursor of the next step
	// Headers are the headers of the image downloads (Referer); the Worker downloads directly first
	Headers map[string]string `json:"headers,omitempty"`
}

// Limits are the largest files the bot can send, by kind (e621 picks a sample over a too big file).
type Limits struct {
	Photo     int64 `json:"photo"`
	Animation int64 `json:"animation"`
	Video     int64 `json:"video"`
}

// ListReq is the body of POST /.
type ListReq struct {
	URL    string `json:"url"`
	Cursor string `json:"cursor,omitempty"`
	Auth   string `json:"auth,omitempty"` // Authorization header of the user's account on the site (e621)
	Limits Limits `json:"limits"`
}

// Source is one gallery site.
type Source struct {
	Name    string
	Match   func(u *url.URL) bool
	Fetch   func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error)
	Resolve func(ctx context.Context, c *Client, page string) (string, error) // image URL of a page item
	Headers map[string]string                                                 // for image downloads (Referer)
}

// sources are all gallery sources: a new source adds its line here.
var sources = []*Source{telegraph, e621, nhentai, ehentai, hitomi, imhentai, hentaifox, asmhentai, muses, multporn, allporncomic, kemono, xlecx, tailspace, rule34, gelbooru, danbooru, furaffinity, pixiv}

func sourceOf(u *url.URL) *Source {
	for _, s := range sources {
		if s.Match(u) {
			return s
		}
	}
	return nil
}

func sourceNamed(name string) *Source {
	for _, s := range sources {
		if s.Name == name {
			return s
		}
	}
	return nil
}
