// POST /clip (multipart: image×N in order, audio) answers an MP4: the images slide in a loop, each for the
// same time, with the audio; its size and length in X-Width, X-Height and X-Duration.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
)

const (
	slot     = 3.0  // seconds per image
	slide    = 0.5  // transition length
	maxClip  = 90.0 // longest clip
	maxImage = 20
	boxW     = 720
	boxH     = 1280
)

func clip(w http.ResponseWriter, r *http.Request) {
	dir, err := os.MkdirTemp("", "clip")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(dir)
	out, width, height, total, err := makeClip(r, dir)
	if err != nil {
		log.Print(err)
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("X-Width", fmt.Sprint(width))
	w.Header().Set("X-Height", fmt.Sprint(height))
	w.Header().Set("X-Duration", fmt.Sprint(total))
	http.ServeFile(w, r, out)
}

func makeClip(r *http.Request, dir string) (out string, width, height int, total float64, err error) {
	if err = r.ParseMultipartForm(32 << 20); err != nil {
		return
	}
	defer r.MultipartForm.RemoveAll()
	images, audios := r.MultipartForm.File["image"], r.MultipartForm.File["audio"]
	if len(images) == 0 || len(audios) != 1 {
		return "", 0, 0, 0, fmt.Errorf("need images and one audio")
	}
	images = images[:min(len(images), maxImage)]
	paths := make([]string, len(images))
	for i, f := range images {
		if paths[i], err = save(f, filepath.Join(dir, fmt.Sprint("img", i))); err != nil {
			return
		}
	}
	audio, err := save(audios[0], filepath.Join(dir, "audio"))
	if err != nil {
		return
	}
	first, err := probeFile(paths[0], "v:0")
	if err != nil || len(first.Streams) == 0 {
		return "", 0, 0, 0, fmt.Errorf("bad image: %v", err)
	}
	sound, err := probeFile(audio, "a:0")
	var length float64
	if err == nil {
		_, err = fmt.Sscan(sound.Format.Duration, &length)
	}
	if err != nil || length <= 0 {
		return "", 0, 0, 0, fmt.Errorf("bad audio: %v", err)
	}
	width, height = fit(first.Streams[0].Width, first.Streams[0].Height)
	total = clipLength(len(paths), length)
	out = filepath.Join(dir, "out.mp4")
	cmd := exec.Command("ffmpeg", clipArgs(paths, audio, out, total, width, height)...)
	if msg, cerr := cmd.CombinedOutput(); cerr != nil {
		return "", 0, 0, 0, fmt.Errorf("ffmpeg: %w: %s", cerr, msg)
	}
	return
}

func save(f *multipart.FileHeader, path string) (string, error) {
	src, err := f.Open()
	if err != nil {
		return "", err
	}
	defer src.Close()
	dst, err := os.Create(path)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(dst, src)
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	return path, err
}

func probeFile(path, stream string) (*probe, error) {
	raw, err := exec.Command("ffprobe", "-v", "error", "-select_streams", stream,
		"-show_entries", "stream=width,height:format=duration", "-of", "json", path).Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe: %w", err)
	}
	var p probe
	return &p, json.Unmarshal(raw, &p)
}

// fit scales w×h down into the 720×1280 box, to even sides (H.264 needs them).
func fit(w, h int) (int, int) {
	f := math.Min(1, math.Min(float64(boxW)/float64(w), float64(boxH)/float64(h)))
	even := func(v int) int { return max(2, int(math.Round(float64(v)*f/2))*2) }
	return even(w), even(h)
}

// clipLength: the audio length up to maxClip, but every image is shown at least once.
func clipLength(n int, audio float64) float64 {
	total := math.Min(audio, maxClip)
	if n > 1 {
		total = math.Max(total, float64(n)*slot)
	}
	return total
}

// clipArgs: one input per shown image (the images repeat until the end), joined by slide transitions;
// the audio loops until the end.
func clipArgs(images []string, audio, out string, total float64, w, h int) []string {
	k := 1
	if len(images) > 1 {
		k = max(len(images), int(math.Ceil(total/slot)))
	}
	args := []string{"-v", "error"}
	for i := range k {
		args = append(args, "-loop", "1")
		if k > 1 {
			args = append(args, "-t", fmt.Sprint(slot+slide))
		}
		args = append(args, "-i", images[i%len(images)])
	}
	args = append(args, "-stream_loop", "-1", "-i", audio)
	graph := ""
	for i := range k {
		graph += fmt.Sprintf("[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p[v%d];", i, w, h, w, h, i)
	}
	last := "v0"
	for i := 1; i < k; i++ {
		graph += fmt.Sprintf("[%s][v%d]xfade=transition=slideleft:duration=%g:offset=%g[x%d];", last, i, slide, float64(i)*slot, i)
		last = fmt.Sprint("x", i)
	}
	return append(args, "-filter_complex", graph[:len(graph)-1], "-map", "["+last+"]", "-map", fmt.Sprintf("%d:a", k),
		"-t", fmt.Sprint(total), "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-tune", "stillimage",
		"-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-y", out)
}
