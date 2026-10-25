// zipimport unpacks a Telegram chat export, finds unique media and stores the new ones
// in R2 through the Worker. Files reach Telegram later, on their first send. It runs once and exits.
//
// Env: ZIP_URL, API_URL (Worker callbacks), TOKEN (callback auth).
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

const (
	photoMax = 10 << 20 // Bot API sendPhoto limit, for the later send
	videoMax = 50 << 20 // Bot API upload limit
	zipPath  = "/tmp/in.zip"
)

var env = struct{ zipURL, apiURL, token string }{os.Getenv("ZIP_URL"), os.Getenv("API_URL"), os.Getenv("TOKEN")}

// media is one file found in the archive.
type media struct {
	file  *zip.File
	thumb *zip.File // optional video/GIF thumbnail from the export
	ref
	sha256 string
}

// Item is what the Worker stores for an imported meme.
type Item struct {
	SHA256   string `json:"sha256"`
	Kind     string `json:"kind"`
	Thumb    bool   `json:"thumb"`
	Mime     string `json:"mime,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
	Duration int    `json:"duration,omitempty"`
	Caption  string `json:"caption,omitempty"`
	Source   string `json:"source,omitempty"`
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		_ = callback("/fail", map[string]string{"error": err.Error()}, nil)
		os.Exit(1)
	}
}

func run() error {
	if err := download(); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open zip: %w", err)
	}
	defer r.Close()

	all, formats, err := findMedia(&r.Reader)
	if err != nil {
		return err
	}
	unique, hashes := []*media{}, []string{}
	seen := map[string]bool{}
	for _, m := range all {
		if m.sha256, err = hashFile(m.file); err != nil {
			return fmt.Errorf("hash %s: %w", m.file.Name, err)
		}
		if !seen[m.sha256] {
			seen[m.sha256] = true
			unique = append(unique, m)
			hashes = append(hashes, m.sha256)
		}
	}
	log.Printf("found %d media, %d unique", len(all), len(unique))

	var filtered struct {
		New []string `json:"new"`
	}
	if err := callback("/filter", map[string]any{"hashes": hashes, "found": len(all), "formats": formats}, &filtered); err != nil {
		return fmt.Errorf("filter: %w", err)
	}
	isNew := map[string]bool{}
	for _, h := range filtered.New {
		isNew[h] = true
	}

	failed := 0
	batch := []Item{}
	for _, m := range unique {
		if !isNew[m.sha256] {
			continue
		}
		item, err := store(m)
		if err != nil {
			log.Printf("store %s: %v", m.file.Name, err)
			failed++
			continue
		}
		if batch = append(batch, item); len(batch) == 20 {
			if err := callback("/items", map[string]any{"items": batch}, nil); err != nil {
				return fmt.Errorf("items: %w", err)
			}
			batch = batch[:0]
		}
	}
	if len(batch) > 0 {
		if err := callback("/items", map[string]any{"items": batch}, nil); err != nil {
			return fmt.Errorf("items: %w", err)
		}
	}
	return callback("/done", map[string]int{"failed": failed}, nil)
}

func download() error {
	req, _ := http.NewRequest("GET", env.zipURL, nil)
	req.Header.Set("Authorization", "Bearer "+env.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("status %d", res.StatusCode)
	}
	f, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, res.Body)
	return err
}

func readFile(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

func hashFile(f *zip.File) (string, error) {
	rc, err := f.Open()
	if err != nil {
		return "", err
	}
	defer rc.Close()
	h := sha256.New()
	if _, err := io.Copy(h, rc); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// store uploads the file (and its thumbnail) to the Worker and returns the item metadata.
func store(m *media) (Item, error) {
	data, err := readFile(m.file)
	if err != nil {
		return Item{}, err
	}
	mime := mimeOf(m.file.Name)
	if err := put("/blob/"+m.sha256, data, mime); err != nil {
		return Item{}, err
	}
	item := Item{
		SHA256: m.sha256, Kind: m.kind, Mime: mime, FileSize: int64(len(data)),
		Width: m.width, Height: m.height, Duration: m.duration, Caption: m.caption, Source: m.source,
	}
	if m.thumb != nil {
		if thumb, err := readFile(m.thumb); err == nil && put("/blob/"+m.sha256+"?thumb=1", thumb, mimeOf(m.thumb.Name)) == nil {
			item.Thumb = true
		}
	}
	return item, nil
}

// ref is a media file referenced by an export (JSON or HTML), relative to the export file.
type ref struct {
	kind, path, caption, source string
	thumb                       string // optional thumbnail path
	width, height, duration     int
}

// findMedia auto-detects the archive layout. Folders with a Telegram Desktop export (result.json or
// messages*.html) give media referenced by the export, with captions, forward source and GIF vs video;
// other files there (stickers, user pictures) are skipped. Media anywhere else is taken by extension.
// It also returns the detected formats: "telegram_json", "telegram_html", "files".
func findMedia(r *zip.Reader) ([]*media, []string, error) {
	byName := map[string]*zip.File{}
	for _, f := range r.File {
		byName[f.Name] = f
	}
	thumbOf := func(name, explicit string) *zip.File {
		if t := byName[explicit]; explicit != "" && t != nil {
			return t
		}
		return byName[name+"_thumb.jpg"]
	}
	out := []*media{}
	formats := map[string]bool{}
	seen := map[string]bool{}
	exportDirs := []string{}
	for _, f := range r.File {
		var refs []ref
		var err error
		switch base := path.Base(f.Name); {
		case base == "result.json":
			refs, err = readExport(f)
			formats["telegram_json"] = true
		case htmlExport.MatchString(base):
			refs, err = readHTML(f)
			formats["telegram_html"] = true
		default:
			continue
		}
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", f.Name, err)
		}
		dir := path.Dir(f.Name)
		exportDirs = append(exportDirs, dir)
		for _, x := range refs {
			name := path.Join(dir, x.path)
			if file := byName[name]; x.kind != "" && file != nil && !seen[name] && fits(x.kind, file) {
				seen[name] = true
				thumb := ""
				if x.thumb != "" {
					thumb = path.Join(dir, x.thumb)
				}
				out = append(out, &media{file: file, thumb: thumbOf(name, thumb), ref: x})
			}
		}
	}
	inExport := func(name string) bool {
		for _, dir := range exportDirs {
			if dir == "." || strings.HasPrefix(name, dir+"/") {
				return true
			}
		}
		return false
	}
	for _, f := range r.File {
		if seen[f.Name] || inExport(f.Name) || junk(f.Name) {
			continue
		}
		if kind := kindByExt(f.Name); kind != "" && fits(kind, f) {
			formats["files"] = true
			out = append(out, &media{file: f, thumb: thumbOf(f.Name, ""), ref: ref{kind: kind}})
		}
	}
	list := []string{}
	for _, name := range []string{"telegram_json", "telegram_html", "files"} {
		if formats[name] {
			list = append(list, name)
		}
	}
	return out, list, nil
}

// junk skips macOS resource forks and hidden files.
func junk(name string) bool {
	return strings.HasPrefix(name, "__MACOSX/") || strings.HasPrefix(path.Base(name), ".")
}

func fits(kind string, f *zip.File) bool {
	if kind == "photo" {
		return f.UncompressedSize64 <= photoMax
	}
	return f.UncompressedSize64 <= videoMax
}

func kindByExt(name string) string {
	if strings.Contains(path.Base(name), "_thumb") {
		return ""
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp":
		return "photo"
	case ".mp4", ".m4v", ".mov", ".webm":
		return "video"
	case ".gif":
		return "animation"
	}
	return ""
}

func mimeOf(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".mov":
		return "video/quicktime"
	case ".webm":
		return "video/webm"
	}
	return "video/mp4"
}

type exportMessage struct {
	Photo         string          `json:"photo"`
	File          string          `json:"file"`
	Thumbnail     string          `json:"thumbnail"`
	MediaType     string          `json:"media_type"`
	Width         int             `json:"width"`
	Height        int             `json:"height"`
	Duration      int             `json:"duration_seconds"`
	Text          json.RawMessage `json:"text"`
	ForwardedFrom string          `json:"forwarded_from"`
}

func (m exportMessage) kind() (string, string) {
	switch {
	case m.Photo != "":
		return "photo", m.Photo
	case m.MediaType == "animation":
		return "animation", m.File
	case m.MediaType == "video_file":
		return "video", m.File
	}
	return "", ""
}

// caption flattens "text", which is a string or a list of strings and {"text": ...} parts.
func (m exportMessage) caption() string {
	var s string
	if json.Unmarshal(m.Text, &s) == nil {
		return s
	}
	var parts []json.RawMessage
	if json.Unmarshal(m.Text, &parts) != nil {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		var obj struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(p, &s) == nil {
			b.WriteString(s)
		} else if json.Unmarshal(p, &obj) == nil {
			b.WriteString(obj.Text)
		}
	}
	return b.String()
}

// readExport reads media refs from a single-chat JSON export or a full account export.
func readExport(f *zip.File) ([]ref, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var doc struct {
		Messages []exportMessage `json:"messages"`
		Chats    struct {
			List []struct {
				Messages []exportMessage `json:"messages"`
			} `json:"list"`
		} `json:"chats"`
	}
	if err := json.NewDecoder(rc).Decode(&doc); err != nil {
		return nil, err
	}
	msgs := doc.Messages
	for _, c := range doc.Chats.List {
		msgs = append(msgs, c.Messages...)
	}
	refs := make([]ref, 0, len(msgs))
	for _, m := range msgs {
		kind, rel := m.kind()
		refs = append(refs, ref{kind, rel, m.caption(), m.ForwardedFrom, m.Thumbnail, m.Width, m.Height, m.Duration})
	}
	return refs, nil
}

// put uploads bytes to the Worker with retries.
func put(p string, data []byte, contentType string) error {
	return withRetry(func() (*http.Response, error) {
		req, _ := http.NewRequest("PUT", env.apiURL+p, bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+env.token)
		req.Header.Set("Content-Type", contentType)
		return http.DefaultClient.Do(req)
	}, nil)
}

// callback posts JSON to the Worker with retries.
func callback(p string, payload any, out any) error {
	b, _ := json.Marshal(payload)
	return withRetry(func() (*http.Response, error) {
		req, _ := http.NewRequest("POST", env.apiURL+p, bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+env.token)
		req.Header.Set("Content-Type", "application/json")
		return http.DefaultClient.Do(req)
	}, out)
}

// withRetry retries network errors, 429 and 5xx with backoff; other statuses fail at once.
func withRetry(do func() (*http.Response, error), out any) error {
	var lastErr error
	for attempt := 0; attempt < 6; attempt++ {
		res, err := do()
		if err == nil {
			if res.StatusCode == 200 {
				defer res.Body.Close()
				if out != nil {
					return json.NewDecoder(res.Body).Decode(out)
				}
				return nil
			}
			msg, _ := io.ReadAll(res.Body)
			res.Body.Close()
			err = fmt.Errorf("status %d: %s", res.StatusCode, msg)
			if res.StatusCode != 429 && res.StatusCode < 500 {
				return err
			}
		}
		lastErr = err
		time.Sleep(time.Duration(1<<attempt) * time.Second)
	}
	return lastErr
}
