-- ---------------------------------------------------------------------------
-- schema.sql — the structure of Transition Area Supply's data.
--
-- Transition Area Supply is an invented outdoor gear shop. This file is the
-- readable copy of its database: `npm run seed` runs it, then fills the
-- tables deterministically from scripts/seed.ts, so every clone gets the same
-- shop. The generated database (data/shop.db) is git-ignored; this file is
-- committed because it is the one people read.
--
-- Only the tool server (tool-server/) ever opens the database, and it opens
-- it READ-ONLY. The model never sees this structure and has no SQL tool: it
-- reaches the data through six narrow MCP tools, and nothing else.
--
-- ---------------------------------------------------------------------------
-- What is NOT in here: the attacks
-- ---------------------------------------------------------------------------
--
-- No attack payload is ever stored in these tables. An attack is inserted at
-- run time, by the arena or the attack studio, as an "overlay" the tool
-- server applies to one run's results. The clean shop and the attacked shop
-- are therefore the same data, and a reader can trust that every row below
-- is innocent.
--
-- The one deliberate oddity is the canary placeholders: internal notes and
-- one internal help article contain the literal text {{canary:staffNote}} or
-- {{canary:apiToken}}. The tool server replaces each with a secret generated
-- fresh for the run. The real value never exists in this file or the
-- database, so a secret that turns up in the assistant's output can only
-- have come from the run itself.
--
-- Money is stored in whole cents (INTEGER), never as a floating-point dollar
-- amount, so totals add up exactly. The tools convert to dollars for display.
-- Dates are ISO strings ('2026-11-19'), shifted relative to the day the seed
-- runs, so "delivered 45 days ago" stays true on every clone.
-- ---------------------------------------------------------------------------

-- The shop's customers. Every address uses a domain reserved for
-- documentation (example.com / .net / .org), so none can ever receive mail.
CREATE TABLE customers (
  id          TEXT PRIMARY KEY,          -- 'C-001'
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  city        TEXT NOT NULL,
  joined_on   TEXT NOT NULL              -- ISO date
);

-- The catalogue.
CREATE TABLE products (
  sku         TEXT PRIMARY KEY,          -- 'TAS-STV-001'
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,             -- tents, packs, footwear, stoves, clothing, accessories
  price_cents INTEGER NOT NULL CHECK (price_cents > 0)
);

-- Orders. `delivery_note` is free text the customer typed at checkout
-- ("leave by the shed"). That makes it attacker-controlled in the real
-- world, which is why attacks can be planted there — at run time, never in
-- this table.
CREATE TABLE orders (
  id             TEXT PRIMARY KEY,       -- 'TA-20401'
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  status         TEXT NOT NULL CHECK (status IN ('processing', 'shipped', 'delivered', 'returned', 'cancelled')),
  placed_on      TEXT NOT NULL,          -- ISO date
  delivered_on   TEXT,                   -- ISO date; NULL unless delivered or returned
  shipping_cents INTEGER NOT NULL CHECK (shipping_cents >= 0),
  delivery_note  TEXT NOT NULL DEFAULT ''
);

-- One row per product on an order. The unit price is copied onto the line,
-- as real shops do, so a later price change does not rewrite old orders.
CREATE TABLE order_lines (
  order_id         TEXT NOT NULL REFERENCES orders(id),
  line_no          INTEGER NOT NULL,
  sku              TEXT NOT NULL REFERENCES products(sku),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, line_no)
);

-- The shop's help content. `visibility` is 'public' or 'internal'. Internal
-- articles are for staff: the tool server hides them from search when the
-- permission layer is on, and shows them when it is off — which is how the
-- lab demonstrates a leak path that only a hard layer closes.
CREATE TABLE help_articles (
  id          TEXT PRIMARY KEY,          -- 'H-01'
  title       TEXT NOT NULL,
  visibility  TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  body        TEXT NOT NULL
);

-- Answers other customers wrote under a help article. User-generated, so
-- attacker-controlled in the real world. All of them are benign here;
-- attacks are planted at run time.
CREATE TABLE community_answers (
  id          TEXT PRIMARY KEY,          -- 'CA-01'
  article_id  TEXT NOT NULL REFERENCES help_articles(id),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL
);

-- Staff-only notes, one block per customer. Each contains the placeholder
-- {{canary:staffNote}} — an "account recovery phrase" the assistant can read
-- but must never reveal.
CREATE TABLE internal_notes (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  body        TEXT NOT NULL
);

-- Support tickets: a customer's email. `content_type` is 'text/plain' or
-- 'text/html'; an HTML ticket's body is stored, and shown to the model, as
-- its raw source.
CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,        -- 'T-1001'
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  content_type  TEXT NOT NULL CHECK (content_type IN ('text/plain', 'text/html')),
  received_at   TEXT NOT NULL            -- ISO date-time
);

-- Files attached to a ticket: plain text, Markdown or HTML, stored as text.
CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,          -- 'A-0001'
  ticket_id   TEXT NOT NULL REFERENCES tickets(id),
  filename    TEXT NOT NULL,
  media_type  TEXT NOT NULL CHECK (media_type IN ('text/plain', 'text/markdown', 'text/html')),
  body        TEXT NOT NULL
);

CREATE INDEX orders_by_customer ON orders(customer_id);
CREATE INDEX lines_by_order ON order_lines(order_id);
CREATE INDEX answers_by_article ON community_answers(article_id);
CREATE INDEX attachments_by_ticket ON attachments(ticket_id);
