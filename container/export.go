package main

// Data export (MODE=export): reads the user's rows, embeddings and media from the Worker, writes
// one .zip and uploads it to R2 in parts. /batch_zip restores such an archive (readMemesave).

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

const (
	manifestName = "memesave-export.json"
	exportPath   = "/tmp/export.zip"
	partSize     = 50 << 20 // R2 multipart part, under the Worker request body limit
)

var tables = []string{"profile", "memes", "transactions", "imports", "zip_imports", "payments", "crypto_invoices", "exports"}

const readme = `memesave data export
====================

This archive holds all data memesave keeps about you. Secrets and internal ids (API keys,
Telegram file ids, payment charge ids, storage keys) are not included.

Files
-----
memesave-export.json    format marker. Do not remove it if you want to import this archive again.
profile.csv             your account: role, language, settings, plan, balance, AI spend.
memes.csv               one row per meme: kind, size, caption, forward source, status, the AI description
                        (title, description, ocr_text, speech_text, meme_context, cultural_meaning,
                        language, tags, search_phrases; lists are separated by new lines), sha256, dates.
                        "file" and "preview" are the paths of the meme's files in this archive
                        (empty when the file could not be read).
media/<id>.<ext>        the original photo, video or GIF of each meme.
media/<id>.preview.jpg  the preview frame of a video or GIF, when it has one.
embeddings/<id>.json    the meme's search vectors: {"image": [...], "text": [...]}. "image" is the embedding
                        of the image (or preview frame), "text" of its description.
transactions.csv        every AI request and its cost in USD.
imports.csv             batch imports.  zip_imports.csv: .zip imports.
payments.csv            payments.  crypto_invoices.csv: crypto invoices.  exports.csv: data exports.

Dates are Unix timestamps (seconds, UTC). CSV files are UTF-8 with a header row.

Import
------
To restore your collection, send /batch_zip to the bot and upload this archive without changes.
Memes with a description are restored with their description and embeddings, without new AI
requests. Memes you already have are skipped.
`

// blob is a raw Worker response (media bytes and their MIME type).
type blob struct {
	data []byte
	mime string
}

// Restore is the description and embeddings of an exported meme, sent with its item on import.
type Restore struct {
	Title           string    `json:"title"`
	Description     string    `json:"description,omitempty"`
	OCRText         string    `json:"ocr_text,omitempty"`
	SpeechText      string    `json:"speech_text,omitempty"`
	MemeContext     string    `json:"meme_context,omitempty"`
	CulturalMeaning string    `json:"cultural_meaning,omitempty"`
	Language        string    `json:"language,omitempty"`
	Tags            string    `json:"tags,omitempty"`
	SearchPhrases   string    `json:"search_phrases,omitempty"`
	CreatedAt       int64     `json:"created_at,omitempty"`
	Image           []float32 `json:"image,omitempty"`
	Text            []float32 `json:"text,omitempty"`
	embedding       *zip.File // embeddings/<id>.json, read only when the item is sent
}

// withVectors returns a copy with the embeddings read from the archive (nil stays nil).
func (r *Restore) withVectors() *Restore {
	if r == nil {
		return nil
	}
	c := *r
	if r.embedding != nil {
		if data, err := readFile(r.embedding); err == nil {
			_ = json.Unmarshal(data, &c)
		}
	}
	return &c
}

type table struct {
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
	Next    any      `json:"next"`
}

// getTable reads all pages of one table as CSV cells.
func getTable(name string) ([]string, [][]string, error) {
	var cols []string
	rows := [][]string{}
	after := "0"
	for {
		var page table
		if err := getNumbers("/table/"+name+"?after="+after, &page); err != nil {
			return nil, nil, fmt.Errorf("table %s: %w", name, err)
		}
		cols = page.Columns
		for _, r := range page.Rows {
			row := make([]string, len(r))
			for i, v := range r {
				row[i] = cell(v)
			}
			rows = append(rows, row)
		}
		if page.Next == nil {
			return cols, rows, nil
		}
		after = cell(page.Next)
	}
}

// getNumbers is get with JSON numbers kept as written (timestamps must not become 1.7e+09).
func getNumbers(p string, out any) error {
	var b blob
	if err := get(p, &b); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(b.data))
	d.UseNumber()
	return d.Decode(out)
}

func cell(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case json.Number:
		return x.String()
	}
	return fmt.Sprint(v)
}

func writeCSV(zw *zip.Writer, name string, cols []string, rows [][]string) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	c := csv.NewWriter(w)
	_ = c.Write(cols)
	_ = c.WriteAll(rows)
	return c.Error()
}

// extOf is the file extension for a MIME type (the reverse of mimeOf).
func extOf(mime string) string {
	switch mime {
	case "image/jpeg":
		return "jpg"
	case "image/png":
		return "png"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	case "video/quicktime", "video/mov":
		return "mov"
	case "video/webm":
		return "webm"
	case "video/mp4":
		return "mp4"
	}
	return "bin"
}

func writeStored(zw *zip.Writer, name string, data []byte) error {
	w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store, Modified: time.Now()})
	if err == nil {
		_, err = w.Write(data)
	}
	return err
}

func runExport() error {
	f, err := os.Create(exportPath)
	if err != nil {
		return err
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	manifest, _ := json.Marshal(map[string]any{"format": "memesave-export", "version": 1, "created_at": time.Now().Unix()})
	if err := writeStored(zw, manifestName, manifest); err != nil {
		return err
	}
	if err := writeStored(zw, "README.txt", []byte(readme)); err != nil {
		return err
	}
	files, failed := 0, 0
	for _, name := range tables {
		cols, rows, err := getTable(name)
		if err != nil {
			return err
		}
		if name == "memes" {
			if cols, rows, files, failed, err = exportMemes(zw, cols, rows); err != nil {
				return err
			}
		}
		if err := writeCSV(zw, name+".csv", cols, rows); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	size, err := upload(f)
	if err != nil {
		return fmt.Errorf("upload: %w", err)
	}
	return callback("/done", map[string]int64{"size": size, "files": int64(files), "failed": int64(failed)}, nil)
}

// exportMemes writes media and embeddings of each meme and adds the "file" and "preview" columns.
func exportMemes(zw *zip.Writer, cols []string, rows [][]string) ([]string, [][]string, int, int, error) {
	col := map[string]int{}
	for i, c := range cols {
		col[c] = i
	}
	files, failed := 0, 0
	for start := 0; start < len(rows); start += 10 {
		chunk := rows[start:min(start+10, len(rows))]
		ids := []string{}
		for _, r := range chunk {
			ids = append(ids, r[col["id"]])
		}
		var vectors []struct {
			ID     string    `json:"id"`
			Values []float32 `json:"values"`
		}
		if err := get("/vectors?ids="+strings.Join(ids, ","), &vectors); err != nil {
			return nil, nil, 0, 0, fmt.Errorf("vectors: %w", err)
		}
		byMeme := map[string]map[string][]float32{}
		for _, v := range vectors {
			id, kind, _ := strings.Cut(v.ID, ":")
			if byMeme[id] == nil {
				byMeme[id] = map[string][]float32{}
			}
			byMeme[id][map[string]string{"i": "image", "t": "text"}[kind]] = v.Values
		}
		for _, id := range ids {
			if byMeme[id] == nil {
				continue
			}
			data, _ := json.Marshal(byMeme[id])
			if err := writeStored(zw, "embeddings/"+id+".json", data); err != nil {
				return nil, nil, 0, 0, err
			}
		}
	}
	for i, r := range rows {
		id, file, preview := r[col["id"]], "", ""
		for _, v := range []struct{ has, variant string }{{r[col["has_file"]], "file"}, {r[col["has_preview"]], "preview"}} {
			if v.has != "1" {
				continue
			}
			var b blob
			if err := get("/media/"+id+"/"+v.variant, &b); err != nil {
				log.Printf("media %s %s: %v", id, v.variant, err)
				failed++
				continue
			}
			name := "media/" + id + "." + extOf(b.mime)
			if v.variant == "preview" {
				name = "media/" + id + ".preview.jpg"
			}
			if err := writeStored(zw, name, b.data); err != nil {
				return nil, nil, 0, 0, err
			}
			files++
			if v.variant == "file" {
				file = name
			} else {
				preview = name
			}
		}
		rows[i] = append(r, file, preview)
	}
	return append(cols, "file", "preview"), rows, files, failed, nil
}

// upload sends the finished archive to R2 as a multipart upload through the Worker.
func upload(f *os.File) (int64, error) {
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if err := callback("/start", map[string]any{}, nil); err != nil {
		return 0, err
	}
	parts := []any{}
	buf := make([]byte, partSize)
	for n, off := 1, int64(0); off < info.Size(); n, off = n+1, off+partSize {
		read, err := f.ReadAt(buf, off)
		if err != nil && err != io.EOF {
			return 0, err
		}
		var part map[string]any
		err = withRetry(func() (*http.Response, error) {
			req, _ := http.NewRequest("PUT", env.apiURL+"/part?n="+strconv.Itoa(n), bytes.NewReader(buf[:read]))
			req.Header.Set("Authorization", "Bearer "+env.token)
			return http.DefaultClient.Do(req)
		}, &part)
		if err != nil {
			return 0, fmt.Errorf("part %d: %w", n, err)
		}
		parts = append(parts, part)
	}
	return info.Size(), callback("/complete", map[string]any{"parts": parts}, nil)
}

// readMemesave reads the memes of a memesave export (memes.csv next to the manifest).
// Memes with a description are restored with it and their embeddings; others are processed again.
func readMemesave(byName map[string]*zip.File, dir string) ([]ref, error) {
	f := byName[path.Join(dir, "memes.csv")]
	if f == nil {
		return nil, fmt.Errorf("memes.csv not found")
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	rows, err := csv.NewReader(rc).ReadAll()
	if err != nil || len(rows) == 0 {
		return nil, fmt.Errorf("memes.csv: %v", err)
	}
	col := map[string]int{}
	for i, c := range rows[0] {
		col[c] = i
	}
	val := func(row []string, name string) string {
		if i, ok := col[name]; ok && i < len(row) {
			return row[i]
		}
		return ""
	}
	num := func(row []string, name string) int {
		n, _ := strconv.Atoi(val(row, name))
		return n
	}
	refs := []ref{}
	for _, row := range rows[1:] {
		x := ref{
			kind: val(row, "kind"), path: val(row, "file"), thumb: val(row, "preview"), caption: val(row, "caption"), source: val(row, "source"),
			width: num(row, "width"), height: num(row, "height"), duration: num(row, "duration"),
		}
		if val(row, "status") == "ready" && val(row, "title") != "" {
			x.restore = &Restore{
				Title: val(row, "title"), Description: val(row, "description"), OCRText: val(row, "ocr_text"), SpeechText: val(row, "speech_text"),
				MemeContext: val(row, "meme_context"), CulturalMeaning: val(row, "cultural_meaning"), Language: val(row, "language"),
				Tags: val(row, "tags"), SearchPhrases: val(row, "search_phrases"), CreatedAt: int64(num(row, "created_at")),
				embedding: byName[path.Join(dir, "embeddings", val(row, "id")+".json")],
			}
		}
		refs = append(refs, x)
	}
	return refs, nil
}
