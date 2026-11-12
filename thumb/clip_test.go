package main

import (
	"slices"
	"strings"
	"testing"
)

func TestClipOneImage(t *testing.T) {
	args := clipArgs([]string{"a"}, "s", "o", clipLength(1, 12.5), 720, 1280)
	if strings.Contains(strings.Join(args, " "), "xfade") || slices.Contains(args, "-t") && args[slices.Index(args, "-t")+1] != "12.5" {
		t.Fatal(args)
	}
	if got := strings.Count(strings.Join(args, " "), "-i "); got != 2 {
		t.Fatalf("inputs %d: %v", got, args)
	}
}

func TestClipLoopsImagesWithSlides(t *testing.T) {
	total := clipLength(2, 10) // 4 slots of 3 s for 10 s of audio
	args := strings.Join(clipArgs([]string{"a", "b"}, "s", "o", total, 720, 960), " ")
	for _, want := range []string{"-t 3.5 -i a -loop 1 -t 3.5 -i b -loop 1 -t 3.5 -i a -loop 1 -t 3.5 -i b -stream_loop -1 -i s",
		"[v0][v1]xfade=transition=slideleft:duration=0.5:offset=3[x1]", "[x2][v3]xfade=transition=slideleft:duration=0.5:offset=9[x3]",
		"-map [x3] -map 4:a -t 10 "} {
		if !strings.Contains(args, want) {
			t.Fatalf("no %q in %s", want, args)
		}
	}
	if clipLength(5, 4) != 15 || clipLength(1, 200) != maxClip {
		t.Fatal("length")
	}
}

func TestFit(t *testing.T) {
	if w, h := fit(1080, 1920); w != 720 || h != 1280 {
		t.Fatal(w, h)
	}
	if w, h := fit(301, 201); w != 302 || h != 202 {
		t.Fatal(w, h)
	}
}
