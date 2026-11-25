-- Session cookies of a user's pixiv and Fur Affinity accounts (src/cookies.ts): imports of the user get R-18 and mature works.
CREATE TABLE site_cookies (
  user_id INTEGER NOT NULL,
  site TEXT NOT NULL CHECK (site IN ('pixiv', 'furaffinity')),
  cookie TEXT NOT NULL, -- encrypted Cookie header
  error TEXT, -- 'expired': the site showed the login wall with the cookies
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, site)
);
