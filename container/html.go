package main

import (
	"archive/zip"
	"html"
	"io"
	"net/url"
	"regexp"
	"strings"
)

// Telegram Desktop HTML export: messages.html, messages2.html, ...
var htmlExport = regexp.MustCompile(`^messages\d*\.html$`)

var (
	messageStart = regexp.MustCompile(`<div class="message [^"]*"`)
	mediaLink    = regexp.MustCompile(`(?s)<a class="(photo_wrap|video_file_wrap|animated_wrap)\b[^"]*" href="([^"]+)"[^>]*>(.*?)</a>`)
	imgSrc       = regexp.MustCompile(`<img[^>]+src="([^"]+)"`)
	textBlock    = regexp.MustCompile(`(?s)<div class="text">(.*?)</div>`)
	forwardFrom  = regexp.MustCompile(`(?s)<div class="forwarded body">\s*<div class="from_name">(.*?)</div>`)
	dateSpan     = regexp.MustCompile(`(?s)<span class="date[^>]*>.*?</span>`)
	lineBreak    = regexp.MustCompile(`<br\s*/?>`)
	anyTag       = regexp.MustCompile(`<[^>]+>`)
)

var htmlKinds = map[string]string{"photo_wrap": "photo", "video_file_wrap": "video", "animated_wrap": "animation"}

func readHTML(f *zip.File) ([]ref, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		return nil, err
	}
	return parseHTML(string(b)), nil
}

// parseHTML finds media links per message block, with the message text as caption
// and the forwarded sender as source.
func parseHTML(doc string) []ref {
	starts := messageStart.FindAllStringIndex(doc, -1)
	refs := []ref{}
	for i, start := range starts {
		end := len(doc)
		if i+1 < len(starts) {
			end = starts[i+1][0]
		}
		block := doc[start[0]:end]
		links := mediaLink.FindAllStringSubmatch(block, -1)
		if len(links) == 0 {
			continue
		}
		caption, source := "", ""
		if m := textBlock.FindStringSubmatch(block); m != nil {
			caption = plain(m[1])
		}
		if m := forwardFrom.FindStringSubmatch(block); m != nil {
			source = plain(dateSpan.ReplaceAllString(m[1], ""))
		}
		for _, l := range links {
			x := ref{kind: htmlKinds[l[1]], path: unescapePath(l[2]), caption: caption, source: source}
			if img := imgSrc.FindStringSubmatch(l[3]); img != nil && x.kind != "photo" {
				x.thumb = unescapePath(img[1])
			}
			refs = append(refs, x)
		}
	}
	return refs
}

func unescapePath(href string) string {
	href = html.UnescapeString(href)
	if p, err := url.PathUnescape(href); err == nil {
		return p
	}
	return href
}

// plain converts an HTML fragment to text, keeping line breaks.
func plain(fragment string) string {
	s := lineBreak.ReplaceAllString(fragment, "\n")
	return strings.TrimSpace(html.UnescapeString(anyTag.ReplaceAllString(s, "")))
}
