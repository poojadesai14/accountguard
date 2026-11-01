-- Cross-account lookups on a decision page: which other accounts used the same
-- link domain, Reply-To domain or IP (store.RelatedIndicators).
create index if not exists events_link_domains on events using gin (link_domains);
create index if not exists events_reply_to_domains on events using gin (reply_to_domains);
create index if not exists events_ip on events (ip) where ip is not null;
