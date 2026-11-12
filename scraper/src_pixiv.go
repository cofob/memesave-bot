package main

import (
	"context"
	"errors"
	"net/url"
	"regexp"
)

// Pixiv artworks: one image is a meme, several are a comic (pages in order). Ugoira (animations) are not importable.
// R-18 works need a login: a guest gets no image URLs, so they fail with 403.

var (
	pixivHost = regexp.MustCompile(`^(www\.)?pixiv\.net$`)
	pixivPath = regexp.MustCompile(`^/([a-z]{2}(-[a-z]+)?/)?artworks/(\d+)`)
	pixivRef  = map[string]string{"Referer": "https://www.pixiv.net/"} // i.pximg.net needs it
)

// pixivID is the artwork id of a link (/artworks/N or the old member_illust.php?illust_id=N), or "".
func pixivID(u *url.URL) string {
	if m := pixivPath.FindStringSubmatch(u.Path); m != nil {
		return m[3]
	}
	if id := u.Query().Get("illust_id"); u.Path == "/member_illust.php" && gbNum.MatchString(id) {
		return id
	}
	return ""
}

var pixiv = &Source{
	Name:    "pixiv",
	Headers: pixivRef,
	Match:   func(u *url.URL) bool { return pixivHost.MatchString(u.Hostname()) && pixivID(u) != "" },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error) {
		id := pixivID(u)
		source := "https://www.pixiv.net/artworks/" + id
		var work struct {
			Body struct {
				Title     string `json:"illustTitle"`
				Comment   string `json:"illustComment"`
				Type      int    `json:"illustType"`
				XRestrict int    `json:"xRestrict"`
				AIType    int    `json:"aiType"`
				UserID    string `json:"userId"`
				UserName  string `json:"userName"`
				Created   string `json:"createDate"`
				Width     int    `json:"width"`
				Height    int    `json:"height"`
				Pages     int    `json:"pageCount"`
				Bookmarks int    `json:"bookmarkCount"`
				Views     int    `json:"viewCount"`
				Tags      struct {
					Tags []struct {
						Tag         string
						Translation map[string]string
					}
				}
			}
		}
		if _, err := c.JSON(ctx, "https://www.pixiv.net/ajax/illust/"+id, pixivRef, &work); err != nil {
			return nil, err
		}
		w := work.Body
		var pages struct {
			Body []struct {
				Urls struct{ Original, Regular string }
			}
		}
		l := &Listing{Source: source}
		if w.Type == 2 { // ugoira: a zip of frames
			return l, nil
		}
		if _, err := c.JSON(ctx, "https://www.pixiv.net/ajax/illust/"+id+"/pages", pixivRef, &pages); err != nil {
			var se *StatusError
			if w.XRestrict > 0 && errors.As(err, &se) && se.Status == 404 { // guests get no pages of R-18 works
				return nil, &StatusError{Status: 403, URL: source}
			}
			return nil, err
		}
		var tags []string
		for _, t := range w.Tags.Tags {
			tags = append(tags, tagName(t.Tag), tagName(t.Translation["en"]))
		}
		tags = uniq(tags)
		if len(pages.Body) > 1 {
			l.Title = str(w.Title)
		}
		for i, p := range pages.Body {
			data := map[string]any{"id": num(id), "title": w.Title, "description": w.Comment, "user": map[string]any{"id": w.UserID, "name": w.UserName},
				"created": w.Created, "width": w.Width, "height": w.Height, "pages": w.Pages, "bookmarks": w.Bookmarks, "views": w.Views, "restrict": w.XRestrict, "ai": w.AIType == 2}
			if len(pages.Body) > 1 {
				data["page"] = i + 1
			}
			if media := pickMedia(ctx, c, p.Urls.Original, p.Urls.Regular, "", q.Limits, pixivRef); media != "" {
				l.Items = append(l.Items, Item{URL: media, Tags: tags, Data: data, Porn: w.XRestrict > 0})
			}
		}
		return l, nil
	},
}
