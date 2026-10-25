package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func TestCellKeepsNumbers(t *testing.T) {
	var v []any
	d := json.NewDecoder(bytes.NewReader([]byte(`[1761350400, 0.5, null, "a\nb", true]`)))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, x := range v {
		got = append(got, cell(x))
	}
	if want := []string{"1761350400", "0.5", "", "a\nb", "true"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

// An archive written by the export is found as "memesave": ready memes carry their description and vectors.
func TestReadMemesaveExport(t *testing.T) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	_ = writeStored(w, "export/"+manifestName, []byte(`{"format":"memesave-export","version":1}`))
	_ = writeStored(w, "export/README.txt", []byte(readme))
	_ = writeCSV(w, "export/memes.csv",
		[]string{"id", "kind", "caption", "status", "title", "tags", "width", "created_at", "file", "preview"},
		[][]string{
			{"m1", "photo", "hi", "ready", "Cat", "cat\nfunny", "640", "1761350400", "media/m1.jpg", ""},
			{"m2", "video", "", "failed", "", "", "", "1761350401", "media/m2.mp4", "media/m2.preview.jpg"},
			{"m3", "photo", "", "ready", "Lost", "", "", "1", "", ""},
		})
	_ = writeStored(w, "export/media/m1.jpg", []byte("A"))
	_ = writeStored(w, "export/media/m2.mp4", []byte("B"))
	_ = writeStored(w, "export/media/m2.preview.jpg", []byte("T"))
	_ = writeStored(w, "export/embeddings/m1.json", []byte(`{"image":[1,2],"text":[3,4]}`))
	_ = writeStored(w, "export/embeddings/m2.json", []byte(`{"image":[5]}`))
	_ = w.Close()

	r, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found, formats, err := findMedia(r)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(formats, []string{"memesave"}) {
		t.Fatalf("formats: %v", formats)
	}
	if len(found) != 2 || found[0].file.Name != "export/media/m1.jpg" || found[1].thumb.Name != "export/media/m2.preview.jpg" {
		t.Fatalf("media: %+v", found)
	}
	if found[1].restore != nil {
		t.Fatal("failed meme must be processed again")
	}
	got := found[0].restore.withVectors()
	want := &Restore{Title: "Cat", Tags: "cat\nfunny", CreatedAt: 1761350400, Image: []float32{1, 2}, Text: []float32{3, 4}, embedding: got.embedding}
	if !reflect.DeepEqual(got, want) || found[0].caption != "hi" || found[0].width != 640 {
		t.Fatalf("restore: %+v", got)
	}
	if found[0].restore.Text != nil {
		t.Fatal("vectors must not stay in memory")
	}
}
