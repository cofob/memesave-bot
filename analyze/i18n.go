package main

import (
	"strings"
	"time"
)

// lang of the chart labels: the user's language from the stats snapshot ("ru" or "en").
var lang = "en"

var words = map[string]map[string]string{
	"ru": {
		"photo": "фото", "video": "видео", "animation": "GIF", "other": "другое", "less": "меньше", "more": "больше",
		"text": "по смыслу", "image": "по картинке", "saved": "сохранено",
		"channel": "каналы", "group": "группы", "user": "люди", "link": "ссылки", "direct": "напрямую",
		"inline": "inline", "share": "поделились", "send": "в чат",
		"key_global": "ключ бота", "key_user": "свой ключ",
		"bot": "бот", "web": "веб", "miniapp": "Mini App", "api": "API", "mcp": "MCP", "zip": "архив", "unknown": "раньше",
		"Mon": "Пн", "Tue": "Вт", "Wed": "Ср", "Thu": "Чт", "Fri": "Пт", "Sat": "Сб", "Sun": "Вс",
	},
	"en": {
		"animation": "GIF", "text": "by meaning", "image": "by image",
		"channel": "channels", "group": "groups", "user": "people", "link": "links", "direct": "direct",
		"share": "shared", "send": "sent to chat",
		"key_global": "bot key", "key_user": "own key",
		"bot": "bot", "web": "web", "miniapp": "Mini App", "api": "API", "mcp": "MCP", "zip": "archive", "unknown": "earlier",
	},
}

// tr translates a chart word; unknown words stay as they are.
func tr(w string) string {
	if v, ok := words[lang][w]; ok {
		return v
	}
	return w
}

var ruMonths = []string{"янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"}

// shortDate turns "2026-10-04" into "Oct 4" / "4 окт" and "2026-10" into "Oct 2026" / "окт 2026"; other labels stay.
func shortDate(s string) string {
	if t, err := time.Parse("2006-01-02", s); err == nil {
		if lang == "ru" {
			return strings.Join([]string{t.Format("2"), ruMonths[t.Month()-1]}, " ")
		}
		return t.Format("Jan 2")
	}
	if t, err := time.Parse("2006-01", s); err == nil {
		if lang == "ru" {
			return ruMonths[t.Month()-1] + " " + t.Format("2006")
		}
		return t.Format("Jan 2006")
	}
	return s
}
