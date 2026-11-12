package main

import (
	"archive/zip"
	"bytes"
	"reflect"
	"testing"
)

func TestFindMediaMixedArchive(t *testing.T) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	add := func(name, body string) {
		f, _ := w.Create(name)
		_, _ = f.Write([]byte(body))
	}
	add("ChatExport/messages.html", `<div class="message default clearfix" id="message1"><div class="body">
		<a class="photo_wrap clearfix pull_left" href="photos/a.jpg"><img src="photos/a_thumb.jpg"/></a>
		<div class="text">hello</div></div></div>`)
	add("ChatExport/photos/a.jpg", "A")
	add("ChatExport/photos/a_thumb.jpg", "thumb")
	add("ChatExport/stickers/s.webp", "sticker") // in an export folder but not referenced
	add("memes/b.png", "B")
	add("memes/clip.mp4", "C")
	add("memes/clip.mp4_thumb.jpg", "T")
	add("memes/notes.txt", "x")
	add("__MACOSX/memes/._b.png", "junk")
	add("memes/.hidden.jpg", "junk")
	_ = w.Close()

	r, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found, formats, err := findMedia(r)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, m := range found {
		thumb := ""
		if m.thumb != nil {
			thumb = m.thumb.Name
		}
		got = append(got, m.kind+" "+m.file.Name+" "+m.caption+" "+thumb)
	}
	want := []string{
		"photo ChatExport/photos/a.jpg hello ",
		"photo memes/b.png  ",
		"video memes/clip.mp4  memes/clip.mp4_thumb.jpg",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("media:\n got %q\nwant %q", got, want)
	}
	if !reflect.DeepEqual(formats, []string{"telegram_html", "files"}) {
		t.Fatalf("formats: %v", formats)
	}
}

func TestFindMediaTiktokSync(t *testing.T) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	add := func(name, body string) {
		f, _ := w.Create(name)
		_, _ = f.Write([]byte(body))
	}
	add("likes/123/meta.json", `{"id":"123","source":"https://www.tiktok.com/@a/video/123","saved_at":1700000000,"desc":"cat",
		"files":[{"position":0,"file":"0.mp4","mime":"video/mp4","thumb":"0.thumb.jpg","width":720,"height":1280,"duration":9.5}]}`)
	add("likes/123/0.mp4", "V")
	add("likes/123/0.thumb.jpg", "T")
	add("other/meta.json", `{"name":"not tiktok"}`) // ignored
	add("other/pic.jpg", "P")
	_ = w.Close()

	r, _ := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	found, formats, err := findMedia(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 || !reflect.DeepEqual(formats, []string{"tiktok", "files"}) {
		t.Fatalf("found %d, formats %v", len(found), formats)
	}
	v := found[0]
	if v.file.Name != "likes/123/0.mp4" || v.thumb == nil || v.thumb.Name != "likes/123/0.thumb.jpg" || v.kind != "video" ||
		v.caption != "cat" || v.source != "https://www.tiktok.com/@a/video/123" || v.savedAt != 1700000000 || v.duration != 9 || v.height != 1280 {
		t.Fatalf("tiktok media: %+v", v.ref)
	}
	if found[1].file.Name != "other/pic.jpg" {
		t.Fatalf("plain file: %s", found[1].file.Name)
	}
}

// Links of a message (text, text links, URL buttons) go with its media, in order.
func TestExportLinks(t *testing.T) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	add := func(name, body string) {
		f, _ := w.Create(name)
		_, _ = f.Write([]byte(body))
	}
	add("chat/result.json", `{"messages":[{"photo":"photos/a.jpg","text":["art by x, ",{"type":"text_link","text":"source","href":"https://e621.net/posts/1"},
		" mirror: rule34.xxx/index.php?page=post&s=view&id=2."],"inline_bot_buttons":[[{"type":"url","text":"FA","data":"https://www.furaffinity.net/view/3/"}]]}]}`)
	add("chat/photos/a.jpg", "A")
	add("html/messages.html", `<div class="message default clearfix" id="message1"><div class="body">
		<a class="photo_wrap clearfix pull_left" href="photos/b.jpg"><img src="photos/b_thumb.jpg"/></a>
		<div class="text">see <a href="https://telegra.ph/Comic-01-01?a=1&amp;b=2">comic</a></div></div></div>`)
	add("html/photos/b.jpg", "B")
	_ = w.Close()

	r, _ := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	found, _, err := findMedia(r)
	if err != nil || len(found) != 2 {
		t.Fatalf("found %d: %v", len(found), err)
	}
	want := []string{"https://e621.net/posts/1", "https://rule34.xxx/index.php?page=post&s=view&id=2", "https://www.furaffinity.net/view/3/"}
	if !reflect.DeepEqual(found[0].links, want) || found[0].caption != "art by x, source mirror: rule34.xxx/index.php?page=post&s=view&id=2." {
		t.Fatalf("json links %q, caption %q", found[0].links, found[0].caption)
	}
	if want := []string{"https://telegra.ph/Comic-01-01?a=1&b=2"}; !reflect.DeepEqual(found[1].links, want) {
		t.Fatalf("html links %q", found[1].links)
	}
}
