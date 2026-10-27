// HTTP service of the Thumbnailer container: POST / with a video body answers a JPEG preview frame
// and the video size in X-Width, X-Height and X-Duration (seconds).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	http.HandleFunc("POST /", thumb)
	srv := &http.Server{Addr: ":8080"}
	go func() {
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	// A platform rollout sends SIGTERM: finish the requests in progress, then exit.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM)
	<-stop
	_ = srv.Shutdown(context.Background())
}

type probe struct {
	Streams []struct{ Width, Height int } `json:"streams"`
	Format  struct{ Duration string }     `json:"format"`
}

func thumb(w http.ResponseWriter, r *http.Request) {
	jpeg, p, err := frame(r.Body)
	if err != nil {
		log.Print(err)
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Width", fmt.Sprint(p.Streams[0].Width))
	w.Header().Set("X-Height", fmt.Sprint(p.Streams[0].Height))
	w.Header().Set("X-Duration", p.Format.Duration)
	_, _ = w.Write(jpeg)
}

// frame saves the video to a temp file (MP4 may need seeking) and runs ffprobe and ffmpeg on it.
func frame(body io.Reader) ([]byte, *probe, error) {
	dir, err := os.MkdirTemp("", "thumb")
	if err != nil {
		return nil, nil, err
	}
	defer os.RemoveAll(dir)
	in, out := filepath.Join(dir, "in"), filepath.Join(dir, "out.jpg")
	f, err := os.Create(in)
	if err != nil {
		return nil, nil, err
	}
	_, err = io.Copy(f, body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, nil, err
	}

	raw, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height:format=duration", "-of", "json", in).Output()
	if err != nil {
		return nil, nil, fmt.Errorf("ffprobe: %w", err)
	}
	var p probe
	if err := json.Unmarshal(raw, &p); err != nil || len(p.Streams) == 0 {
		return nil, nil, fmt.Errorf("no video stream")
	}
	// thumbnail picks a typical frame of the first 100 (skips black and transition frames).
	cmd := exec.Command("ffmpeg", "-v", "error", "-i", in, "-vf", "thumbnail,scale=320:320:force_original_aspect_ratio=decrease",
		"-frames:v", "1", "-q:v", "3", out)
	if msg, err := cmd.CombinedOutput(); err != nil {
		return nil, nil, fmt.Errorf("ffmpeg: %w: %s", err, msg)
	}
	jpeg, err := os.ReadFile(out)
	return jpeg, &p, err
}
