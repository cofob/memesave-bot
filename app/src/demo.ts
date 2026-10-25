import type { Kind } from "./api";
import { isRu } from "./strings";

// Landing demo: drawn memes with what the AI writes for them, in the fields of the real app.
export interface DemoMeme {
  id: string;
  kind: Kind;
  img: string;
  from: string;
  title: string;
  tags: string[];
  ocr_text: string;
  speech_text: string;
  description: string;
  cultural_meaning: string;
  phrases: string;
  caption: string;
  query: string; // typed in the search step
}

type Text = Pick<DemoMeme, "from" | "title" | "tags" | "ocr_text" | "speech_text" | "description" | "cultural_meaning" | "query">;
type Art = { kind: Kind; emoji: string; bg: string };

const art: Art[] = [
  { kind: "photo", emoji: "😩", bg: "#5b8def" },
  { kind: "animation", emoji: "🥳", bg: "#e86f9a" },
  { kind: "photo", emoji: "🐈", bg: "#f0a23b" },
  { kind: "video", emoji: "🔥", bg: "#d9534f" },
  { kind: "photo", emoji: "🤡", bg: "#7a5cc7" },
  { kind: "animation", emoji: "🧠", bg: "#2fa56b" },
];

const en: Text[] = [
  {
    from: "Daily Memes",
    title: "Monday again",
    tags: ["monday", "work", "tired"],
    ocr_text: "WHEN THE ALARM\nRINGS AT 7 AGAIN",
    speech_text: "",
    description: "An exhausted emoji on a blue background with a caption about the alarm clock.",
    cultural_meaning: "Tiredness from work and the start of the week: everyone knows Monday mornings.",
    query: "alarm",
  },
  {
    from: "Dev Humor",
    title: "Code works on the first try",
    tags: ["programming", "success", "party"],
    ocr_text: "IT COMPILES",
    speech_text: "",
    description: "An animated party emoji celebrates under the caption “it compiles”.",
    cultural_meaning: "A programmer's joy at a success they cannot believe.",
    query: "compiles",
  },
  {
    from: "Daily Memes",
    title: "Waiting for Friday",
    tags: ["cat", "friday", "weekend"],
    ocr_text: "ME ON\nTHURSDAY EVENING",
    speech_text: "",
    description: "A cat sits by the window and looks into the distance.",
    cultural_meaning: "Impatience before the weekend: one more day until rest.",
    query: "cat",
  },
  {
    from: "Dev Humor",
    title: "Everything is fine",
    tags: ["deadline", "panic", "work"],
    ocr_text: "DEADLINE\nTOMORROW",
    speech_text: "Everything is under control.",
    description: "A video of a fire emoji with a caption about the deadline and calm music.",
    cultural_meaning: "Calm outside, panic inside when deadlines burn.",
    query: "deadline",
  },
  {
    from: "Daily Memes",
    title: "Me after “one more episode”",
    tags: ["series", "sleep", "self-irony"],
    ocr_text: "ONE MORE EPISODE\nTHEN BED",
    speech_text: "",
    description: "A clown emoji on a purple background with a caption about a TV series.",
    cultural_meaning: "Self-irony about one more broken promise to go to bed early.",
    query: "episode",
  },
  {
    from: "Dev Humor",
    title: "Genius idea at 3 a.m.",
    tags: ["ideas", "night", "brain"],
    ocr_text: "MY BRAIN\nAT 3 A.M.",
    speech_text: "",
    description: "An animated glowing brain on a green background.",
    cultural_meaning: "The best ideas come when it is time to sleep.",
    query: "brain",
  },
];

const ru: Text[] = [
  {
    from: "Мемы для своих",
    title: "Опять понедельник",
    tags: ["понедельник", "работа", "усталость"],
    ocr_text: "КОГДА БУДИЛЬНИК\nОПЯТЬ В 7:00",
    speech_text: "",
    description: "Измученный эмодзи на синем фоне, сверху подпись про будильник.",
    cultural_meaning: "Усталость от работы и начала недели: каждый узнаёт себя в понедельник утром.",
    query: "будильник",
  },
  {
    from: "Код и котики",
    title: "Код заработал с первого раза",
    tags: ["программирование", "успех", "праздник"],
    ocr_text: "ОНО\nКОМПИЛИРУЕТСЯ",
    speech_text: "",
    description: "Анимированный эмодзи с хлопушкой празднует под подписью «оно компилируется».",
    cultural_meaning: "Радость программиста от успеха, в который он сам не верит.",
    query: "компилируется",
  },
  {
    from: "Мемы для своих",
    title: "Жду пятницу",
    tags: ["кот", "пятница", "выходные"],
    ocr_text: "Я В ЧЕТВЕРГ\nВЕЧЕРОМ",
    speech_text: "",
    description: "Кот сидит у окна и смотрит вдаль.",
    cultural_meaning: "Нетерпение перед выходными: до отдыха остался один день.",
    query: "кот",
  },
  {
    from: "Код и котики",
    title: "Всё нормально",
    tags: ["дедлайн", "паника", "работа"],
    ocr_text: "ДЕДЛАЙН\nЗАВТРА",
    speech_text: "Всё под контролем.",
    description: "Видео с эмодзи огня, подписью про дедлайн и спокойной музыкой.",
    cultural_meaning: "Спокойствие снаружи и паника внутри, когда горят сроки.",
    query: "дедлайн",
  },
  {
    from: "Мемы для своих",
    title: "Я после «ещё одной серии»",
    tags: ["сериал", "сон", "самоирония"],
    ocr_text: "ЕЩЁ ОДНУ СЕРИЮ\nИ СПАТЬ",
    speech_text: "",
    description: "Эмодзи клоуна на фиолетовом фоне, подпись про сериал.",
    cultural_meaning: "Самоирония над очередным обещанием лечь пораньше.",
    query: "серию",
  },
  {
    from: "Код и котики",
    title: "Гениальная идея в 3 ночи",
    tags: ["идеи", "ночь", "мозг"],
    ocr_text: "МОЙ МОЗГ\nВ 3 НОЧИ",
    speech_text: "",
    description: "Анимированный светящийся мозг на зелёном фоне.",
    cultural_meaning: "Лучшие идеи приходят, когда пора спать.",
    query: "мозг",
  },
];

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A square meme picture: the emoji on a colored background with the caption on top. */
function draw(a: Art, caption: string) {
  const lines = caption
    .split("\n")
    .map((line, i) => `<text x="200" y="${62 + i * 44}">${esc(line)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${a.bg}"/><text x="200" y="300" font-size="170" text-anchor="middle">${a.emoji}</text><g font-family="Impact,'Arial Black',sans-serif" font-size="38" font-weight="900" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke" text-anchor="middle">${lines}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const demo: DemoMeme[] = (isRu ? ru : en).map((text, i) => ({
  ...text,
  id: `demo${i}`,
  kind: art[i]!.kind,
  img: draw(art[i]!, text.ocr_text),
  phrases: "",
  caption: "",
}));
