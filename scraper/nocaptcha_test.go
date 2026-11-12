package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTurnstile(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		switch r.URL.Path {
		case "/createTask":
			task := b["task"].(map[string]any)
			if b["clientKey"] != "K" || task["type"] != "AntiTurnstileTask" || task["websiteKey"] == "bad" {
				_, _ = w.Write([]byte(`{"errorId":10,"errorCode":"ERROR_BAD_PARAMETERS"}`))
				return
			}
			_, _ = w.Write([]byte(`{"errorId":0,"status":"idle","taskId":"T1"}`))
		case "/getTaskResult":
			if polls++; polls < 2 {
				_, _ = w.Write([]byte(`{"errorId":0,"status":"processing"}`))
				return
			}
			_, _ = w.Write([]byte(`{"errorId":0,"status":"ready","solution":{"token":"0.tok"}}`))
		}
	}))
	defer srv.Close()
	nocaptchaURL, nocaptchaPoll = srv.URL, time.Millisecond

	tok, err := turnstile(t.Context(), "K", "https://site.test/", "0x4AAA")
	eq(t, [2]any{tok, err}, [2]any{"0.tok", nil})
	eq(t, polls, 2)
	if _, err := turnstile(t.Context(), "K", "https://site.test/", "bad"); err == nil || !strings.Contains(err.Error(), "ERROR_BAD_PARAMETERS") {
		t.Fatal(err)
	}
}
