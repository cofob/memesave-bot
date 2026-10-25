package main

import (
	"reflect"
	"testing"
)

const sample = `
<div class="message service" id="message-1"><div class="body details">24 October 2026</div></div>
<div class="message default clearfix" id="message10">
 <div class="body">
  <div class="from_name">Alice</div>
  <div class="media_wrap clearfix">
   <a class="photo_wrap clearfix pull_left" href="photos/photo_1@24-10-2026_10-00-00.jpg">
    <img class="photo" src="photos/photo_1@24-10-2026_10-00-00_thumb.jpg"/>
   </a>
  </div>
  <div class="text">When the deploy &amp; tests pass<br>on Friday</div>
 </div>
</div>
<div class="message default clearfix joined" id="message11">
 <div class="body">
  <div class="forwarded body">
   <div class="from_name">Memes Channel <span class="date details" title="01.01.2026 10:00:00"> 01.01.2026 10:00:00</span></div>
   <div class="media_wrap clearfix">
    <a class="animated_wrap clearfix pull_left" href="video_files/my%20gif.gif.mp4"><img class="animated" src="video_files/x_thumb.jpg"/></a>
   </div>
  </div>
 </div>
</div>
<div class="message default clearfix" id="message12">
 <div class="body"><div class="media_wrap clearfix">
  <a class="video_file_wrap clearfix pull_left" href="video_files/clip.mp4"><img class="video_file" src="video_files/clip.mp4_thumb.jpg"/></a>
 </div></div>
</div>
<div class="message default clearfix" id="message13"><div class="body"><div class="text">just text</div></div></div>`

func TestParseHTML(t *testing.T) {
	got := parseHTML(sample)
	want := []ref{
		{kind: "photo", path: "photos/photo_1@24-10-2026_10-00-00.jpg", caption: "When the deploy & tests pass\non Friday"},
		{kind: "animation", path: "video_files/my gif.gif.mp4", source: "Memes Channel", thumb: "video_files/x_thumb.jpg"},
		{kind: "video", path: "video_files/clip.mp4", thumb: "video_files/clip.mp4_thumb.jpg"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseHTML:\n got %#v\nwant %#v", got, want)
	}
	if !htmlExport.MatchString("messages.html") || !htmlExport.MatchString("messages12.html") || htmlExport.MatchString("lists.html") {
		t.Fatal("htmlExport pattern")
	}
}
