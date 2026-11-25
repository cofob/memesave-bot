// POST /mp4 with a video body (e.g. WebM) answers it as MP4: H.264 + AAC, +faststart, so Telegram plays it.
package main

import (
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
)

func mp4(w http.ResponseWriter, r *http.Request) {
	dir, err := os.MkdirTemp("", "mp4")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(dir)
	in, out := filepath.Join(dir, "in"), filepath.Join(dir, "out.mp4")
	if err = saveBody(r.Body, in); err == nil {
		var msg []byte
		if msg, err = exec.Command("ffmpeg", mp4Args(in, out)...).CombinedOutput(); err != nil {
			log.Printf("ffmpeg: %v: %s", err, msg)
		}
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	http.ServeFile(w, r, out)
}

func saveBody(body io.Reader, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// mp4Args: the first video stream (even sides for H.264) and the first audio stream, if any.
func mp4Args(in, out string) []string {
	return []string{"-v", "error", "-i", in, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-y", out}
}
