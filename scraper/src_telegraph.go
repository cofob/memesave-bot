package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// Telegraph pages (telegra.ph): the images of the article in order.

type tgNode struct {
	Tag      string            `json:"tag"`
	Attrs    map[string]string `json:"attrs"`
	Children []json.RawMessage `json:"children"`
}

// tgImages returns the img src of the nodes in order; a node is a string or an element.
func tgImages(nodes []json.RawMessage) []string {
	var out []string
	for _, raw := range nodes {
		var n tgNode
		if json.Unmarshal(raw, &n) != nil { // a text node
			continue
		}
		if n.Tag == "img" && n.Attrs["src"] != "" {
			out = append(out, n.Attrs["src"])
		} else {
			out = append(out, tgImages(n.Children)...)
		}
	}
	return out
}

type tgMeta struct {
	Title       string `json:"title"`
	AuthorName  string `json:"author_name,omitempty"`
	AuthorURL   string `json:"author_url,omitempty"`
	Description string `json:"description,omitempty"`
}

var tgPath = regexp.MustCompile(`^/[^/]+/?$`)

var telegraph = &Source{
	Name: "telegraph",
	Match: func(u *url.URL) bool {
		return slices.Contains([]string{"telegra.ph", "graph.org"}, u.Hostname()) && tgPath.MatchString(u.Path)
	},
	Fetch: func(ctx context.Context, c *Client, u *url.URL, _ ListReq) (*Listing, error) {
		slug := strings.Trim(u.Path, "/")
		var page struct {
			OK     bool   `json:"ok"`
			Error  string `json:"error"`
			Result *struct {
				tgMeta
				Content []json.RawMessage `json:"content"`
			} `json:"result"`
		}
		if _, err := c.JSON(ctx, "https://api.telegra.ph/getPage/"+slug+"?return_content=true", nil, &page); err != nil {
			return nil, err
		}
		if !page.OK || page.Result == nil {
			return nil, fmt.Errorf("telegraph: %s", page.Error)
		}
		r := page.Result
		var items []Item
		for _, src := range tgImages(r.Content) {
			items = append(items, Item{URL: abs(src, "https://telegra.ph")}) // /file/… is relative
		}
		return &Listing{Source: "https://telegra.ph/" + slug, Title: &r.Title, Data: r.tgMeta, Items: items}, nil
	},
}
