package main

import (
	"bytes"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestMp4FromWebm(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg")
	}
	webm := filepath.Join(t.TempDir(), "in.webm")
	if msg, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=63x47:duration=1", "-f", "lavfi", "-i", "sine=duration=1",
		"-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest", webm).CombinedOutput(); err != nil {
		t.Skip("no webm encoder: ", string(msg))
	}
	body, _ := os.ReadFile(webm)
	w := httptest.NewRecorder()
	mp4(w, httptest.NewRequest("POST", "/mp4", bytes.NewReader(body)))
	if w.Code != 200 || w.Header().Get("Content-Type") != "video/mp4" || !bytes.Contains(w.Body.Bytes()[:64], []byte("ftyp")) {
		t.Fatal(w.Code, w.Body.String()[:min(200, w.Body.Len())])
	}
	w = httptest.NewRecorder()
	mp4(w, httptest.NewRequest("POST", "/mp4", bytes.NewReader([]byte("junk"))))
	if w.Code != 422 {
		t.Fatal(w.Code)
	}
}
